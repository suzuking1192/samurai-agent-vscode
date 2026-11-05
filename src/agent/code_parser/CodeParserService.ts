import * as path from "path";
import { TextDecoder } from "util";
import * as vscode from "vscode";
import { CodeElement, CodeElementType, FileInfo } from "../../common/models/context-models";
import { LLMProviderService } from "../llm/llmProviderService";
import { LLMMessage, LLMRequest, LLMResponse } from "../../common/models/llm-models";
import { ResponseType } from "../../common/models/response-models";
import { promises as fsPromises, existsSync, statSync } from "fs";
import { DocumentationExtractor } from "./DocumentationExtractor";
import { RelationshipTracker } from "./RelationshipTracker";
import { PatternDetector } from "./PatternDetector";
import { ExportAnalyzer } from "./ExportAnalyzer";
import { Project, SourceFile, SyntaxKind, Node } from "ts-morph";
import * as ts from "typescript";

const textDecoder = new TextDecoder("utf-8");

const buildPatternMap = <T extends Record<string, Record<string, RegExp>>>(patterns: T): Map<string, Record<string, RegExp>> => {
    return new Map<string, Record<string, RegExp>>(Object.entries(patterns));
};

interface RelevantFileSelection {
    [filePath: string]: string[];
}

export class CodeParserService {
    private readonly workspaceRoot: string | null;
    private readonly llmProvider?: LLMProviderService;
    private readonly promptCache: Map<string, string> = new Map();
    private readonly documentationExtractor: DocumentationExtractor = new DocumentationExtractor();
    private readonly relationshipTracker: RelationshipTracker = new RelationshipTracker();
    private readonly patternDetector: PatternDetector = new PatternDetector();
    private readonly exportAnalyzer: ExportAnalyzer = new ExportAnalyzer();
    private readonly languagePatterns: Array<[string, RegExp]> = [
        ["python", /\.(py|pyw)$/i],
        ["javascript", /\.(js|jsx)$/i],
        ["typescript", /\.(ts|tsx)$/i],
        ["java", /\.(java)$/i],
        ["cpp", /\.(cpp|cc|cxx|h|hpp|hxx)$/i],
        ["csharp", /\.(cs)$/i],
        ["go", /\.(go)$/i],
        ["rust", /\.(rs)$/i],
        ["php", /\.(php)$/i],
        ["ruby", /\.(rb)$/i],
        ["shell", /\.(sh|bash|zsh|fish)$/i],
        ["powershell", /\.(ps1)$/i],
        ["batch", /\.(bat|cmd)$/i],
        ["html", /\.(html|htm)$/i],
        ["css", /\.(css|scss|sass|less)$/i],
        ["json", /\.(json)$/i],
        ["yaml", /\.(ya?ml)$/i],
        ["sql", /\.(sql)$/i],
        ["markdown", /\.(md|markdown)$/i],
    ];
    private readonly elementPatterns: Map<string, Record<string, RegExp>> = buildPatternMap({
        python: {
            function: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/,
            class: /^\s*class\s+(\w+)/,
            // Phase 1: New patterns for Python
            type_definition: /^\s*(\w+)\s*:\s*TypeAlias\s*=/,  // PEP 613
            enum: /^\s*class\s+(\w+)\s*\(\s*Enum\s*\)/,  // Enum class
            constant: /^\s*([A-Z][A-Z0-9_]*)\s*=/,  // UPPER_CASE constants
            annotation: /^\s*@(\w+)/,  // Decorators
        },
        javascript: {
            function: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
            class: /^\s*(?:export\s+)?class\s+(\w+)/,
            method: /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
            arrow_function: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/,
            // Phase 1: New patterns for JavaScript
            constant: /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/,
            export: /^\s*export\s+(?:const|function|class|let|var)\s+(\w+)/,
        },
        typescript: {
            function: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
            class: /^\s*(?:export\s+)?class\s+(\w+)/,
            method: /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
            arrow_function: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/,
            interface: /^\s*(?:export\s+)?interface\s+(\w+)/,
            // Phase 1: New patterns for TypeScript
            type_definition: /^\s*(?:export\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=/,  // Supports generics
            enum: /^\s*(?:export\s+)?(?:const\s+)?enum\s+(\w+)/,  // Supports const enum
            constant: /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/,
            annotation: /^\s*@(\w+)/,  // Decorators
            export: /^\s*export\s+(?:const|function|class|type|enum|interface)\s+(\w+)/,
            namespace: /^\s*(?:export\s+)?namespace\s+(\w+)/,
        },
        java: {
            class: /^\s*(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/,
            method: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:synchronized\s+)?(?:native\s+)?(?:strictfp\s+)?(?:<[^>]+>\s+)?(?:[\w<>\[\]]+\s+)?(\w+)\s*\(/,
            interface: /^\s*(?:public\s+)?interface\s+(\w+)/,
            // Phase 1: New patterns for Java
            enum: /^\s*(?:public\s+)?enum\s+(\w+)/,
            constant: /^\s*(?:public\s+)?static\s+final\s+(?:\w+\s+)?(\w+)\s*=/,
            annotation: /^\s*@(\w+)/,
        },
        cpp: {
            class: /^\s*(?:class|struct)\s+(\w+)/,
            function: /^\s*(?:[\w<>\[\]]+\s+)?(\w+)\s*\([^)]*\)\s*\{?/,
            // Phase 1: New patterns for C++
            type_definition: /^\s*(?:typedef|using)\s+.*\s+(\w+)\s*[;=]/,
            enum: /^\s*enum\s+(?:class\s+)?(\w+)/,
            constant: /^\s*(?:const|constexpr)\s+.*\s+(\w+)\s*=/,
            namespace: /^\s*namespace\s+(\w+)/,
        },
        csharp: {
            class: /^\s*(?:public\s+)?(?:abstract\s+)?(?:sealed\s+)?(?:partial\s+)?class\s+(\w+)/,
            method: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:virtual\s+)?(?:abstract\s+)?(?:override\s+)?(?:sealed\s+)?(?:async\s+)?(?:<[^>]+>\s+)?(?:[\w<>\[\]]+\s+)?(\w+)\s*\(/,
            interface: /^\s*(?:public\s+)?interface\s+(\w+)/,
            // Phase 1: New patterns for C#
            enum: /^\s*(?:public\s+)?enum\s+(\w+)/,
            constant: /^\s*(?:public\s+)?const\s+(?:\w+\s+)?(\w+)\s*=/,
            annotation: /^\s*\[(\w+)/,  // Attributes
            namespace: /^\s*namespace\s+([\w.]+)/,
        },
        go: {
            function: /^\s*func\s+(\w+)\s*\(/,
            method: /^\s*func\s*\([^)]+\)\s+(\w+)\s*\(/,
            struct: /^\s*type\s+(\w+)\s+struct/,
            interface: /^\s*type\s+(\w+)\s+interface/,
            // Phase 1: New patterns for Go
            type_definition: /^\s*type\s+(\w+)\s+(?:struct|interface)/,
            constant: /^\s*const\s+(\w+)\s*=/,
        },
        rust: {
            function: /^\s*(?:pub\s+)?fn\s+(\w+)\s*\(/,
            struct: /^\s*(?:pub\s+)?struct\s+(\w+)/,
            impl: /^\s*impl\s+(\w+)/,
            trait: /^\s*(?:pub\s+)?trait\s+(\w+)/,
            // Phase 1: New patterns for Rust
            type_definition: /^\s*(?:pub\s+)?type\s+(\w+)\s*=/,
            enum: /^\s*(?:pub\s+)?enum\s+(\w+)/,
            constant: /^\s*(?:pub\s+)?const\s+(\w+)\s*:/,
            annotation: /^\s*#\[(\w+)/,  // Attributes
        },
        php: {
            function: /^\s*(?:public|private|protected)?\s*(?:static\s+)?function\s+(\w+)\s*\(/,
            class: /^\s*class\s+(\w+)/,
            interface: /^\s*interface\s+(\w+)/,
            // Phase 1: New patterns for PHP
            enum: /^\s*enum\s+(\w+)/,  // PHP 8.1+
            constant: /^\s*(?:public\s+)?const\s+(\w+)\s*=/,
            annotation: /^\s*#\[(\w+)/,  // PHP 8 attributes
            namespace: /^\s*namespace\s+([\w\\]+)/,
        },
        ruby: {
            method: /^\s*def\s+(\w+)/,
            class: /^\s*class\s+(\w+)/,
            module: /^\s*module\s+(\w+)/,
            // Phase 1: New patterns for Ruby
            constant: /^\s*([A-Z][A-Z0-9_]*)\s*=/,  // UPPER_CASE constants
        },
    });
    private readonly ignorePatternSources: string[] = [
        "\\.git",
        "\\.svn",
        "\\.hg",
        "node_modules",
        "__pycache__",
        "\\.pytest_cache",
        "\\.venv",
        "venv",
        "env",
        "\\.env",
        "\\.env\\..*",
        "pip.*\\.log",
        "lib/python\\d+\\.\\d+/site-packages",
        "lib64/python\\d+\\.\\d+/site-packages",
        "lib/python\\d+\\.\\d+/dist-packages",
        "lib64/python\\d+\\.\\d+/dist-packages",
        "site-packages",
        "dist-packages",
        "\\.local/lib/python\\d+\\.\\d+/site-packages",
        "\\.local/lib64/python\\d+\\.\\d+/site-packages",
        "bin/python\\d+\\.\\d+",
        "Scripts/python\\d+\\.\\d+",
        "\\.python-version",
        "\\.npm",
        "\\.yarn",
        "\\.pnpm",
        "\\.cargo",
        "\\.maven",
        "\\.gradle",
        "\\.conda",
        "\\.anaconda",
        "\\.miniconda",
        "\\.poetry",
        "\\.pip",
        "\\.pipenv",
        "\\.virtualenv",
        "\\.virtualenvs",
        "\\.pyenv",
        "\\.pyenv-versions",
        "\\.rbenv",
        "\\.rvm",
        "\\.nvm",
        "\\.nvm-versions",
        "\\.jenv",
        "\\.sdkman",
        "\\.asdf",
        "\\.asdf-versions",
        "\\.DS_Store",
        "\\.idea",
        "\\.vscode",
        "\\.sublime",
        "\\.vim",
        "\\.emacs",
        "\\.cache",
        "\\.build",
        "dist",
        "/build/",
        "^build/",
        "build$",
        "/target/",
        "^target/",
        "target$",
        "/bin/",
        "^bin/",
        "bin$",
        "/obj/",
        "^obj/",
        "obj$",
        "/out/",
        "^out/",
        "out$",
        "\\.next",
        "\\.nuxt",
        "\\.output",
        "\\.parcel-cache",
        "\\.webpack",
        "coverage",
        "\\.coverage",
        "\\.nyc_output",
        "\\.lcov",
        "htmlcov",
        "\\.tox",
        "\\.log$",
        "\\.tmp$",
        "\\.temp$",
        "\\.swp$",
        "\\.swo$",
        "\\.bak$",
        "\\.backup$",
        "package-lock\\.json$",
        "yarn\\.lock$",
        "pnpm-lock\\.yaml$",
        "poetry\\.lock$",
        "pipfile\\.lock$",
        "readme\\.md$",
        "changelog\\.md$",
        "history\\.md$",
        "contributing\\.md$",
        "contributors\\.md$",
        "code_of_conduct\\.md$",
        "security\\.md$",
        "support\\.md$",
        "funding\\.yml$",
        "license$",
        "license\\.md$",
        "license\\.txt$",
        "copying$",
        "authors$",
        "maintainers$",
        "\\.rst$",
        "\\.md$",
        "readme\\.txt$",
        "changelog\\.txt$",
        "history\\.txt$",
        "license\\.txt$",
        "authors\\.txt$",
        "contributors\\.txt$",
        "maintainers\\.txt$",
        "copying\\.txt$",
        "docs?\\.txt$",
        "notes?\\.txt$",
        "manual\\.txt$",
        "guide\\.txt$",
        "tutorial\\.txt$",
        "help\\.txt$",
        "about\\.txt$",
        "info\\.txt$",
        "\\.doc$",
        "\\.docx$",
        "\\.pdf$",
        "\\.rtf$",
        "\\.tex$",
        "\\.latex$",
        "\\.eslintrc",
        "\\.prettierrc",
        "\\.babelrc",
        "\\.browserslistrc",
        "\\.editorconfig",
        "\\.gitignore",
        "\\.gitattributes",
        "\\.dockerignore",
        "\\.npmignore",
        "\\.min\\.js$",
        "\\.min\\.css$",
        "\\.bundle\\.js$",
        "\\.chunk\\.js$",
        "\\.png$",
        "\\.jpg$",
        "\\.jpeg$",
        "\\.gif$",
        "\\.bmp$",
        "\\.tiff$",
        "\\.tif$",
        "\\.webp$",
        "\\.svg$",
        "\\.ico$",
        "\\.icns$",
        "\\.woff$",
        "\\.woff2$",
        "\\.ttf$",
        "\\.otf$",
        "\\.eot$",
        "\\.mp4$",
        "\\.avi$",
        "\\.mov$",
        "\\.wmv$",
        "\\.flv$",
        "\\.webm$",
        "\\.mkv$",
        "\\.m4v$",
        "\\.mp3$",
        "\\.wav$",
        "\\.flac$",
        "\\.aac$",
        "\\.ogg$",
        "\\.m4a$",
        "\\.zip$",
        "\\.tar$",
        "\\.gz$",
        "\\.bz2$",
        "\\.xz$",
        "\\.rar$",
        "\\.7z$",
        "\\.dmg$",
        "\\.iso$",
        "\\.db$",
        "\\.sqlite$",
        "\\.sqlite3$",
        "\\.csv$",
        "\\.xlsx$",
        "\\.xls$",
        "\\.ods$",
        "\\.ppt$",
        "\\.pptx$",
        "\\.odp$",
        "\\.exe$",
        "\\.dll$",
        "\\.so$",
        "\\.dylib$",
        "\\.bin$",
        "\\.app$",
        "\\.deb$",
        "\\.rpm$",
        "\\.msi$",
        "\\.lock$",
        "\\.pid$",
        "~$",
        "\\.orig$",
        "\\.rej$",
        "thumbs\\.db$",
        "\\.trashes",
        "\\.spotlight-v100",
        "\\.fseventsd",
        "\\.github",
        "\\.gitlab-ci\\.yml$",
        "\\.travis\\.yml$",
        "\\.circleci",
        "\\.jenkins",
        "\\.pem$",
        "\\.key$",
        "\\.crt$",
        "\\.cer$",
        "\\.p12$",
        "\\.pfx$",
    ];
    private readonly ignorePatterns: RegExp[];
    private readonly coreCodeExtensions = new Set<string>([
        ".py",
        ".js",
        ".ts",
        ".jsx",
        ".tsx",
        ".java",
        ".cpp",
        ".cc",
        ".cxx",
        ".c",
        ".h",
        ".hpp",
        ".cs",
        ".go",
        ".rs",
        ".php",
        ".rb",
        ".swift",
        ".kt",
        ".m",
        ".mm",
    ]);
    private readonly secondaryCodeExtensions = new Set<string>([
        ".vue",
        ".svelte",
        ".r",
        ".scala",
        ".clj",
        ".cljs",
        ".hs",
        ".ml",
        ".fs",
        ".dart",
        ".elm",
        ".ex",
        ".exs",
        ".erl",
        ".jl",
        ".lua",
        ".pl",
        ".pm",
        ".sh",
        ".bash",
        ".zsh",
        ".fish",
        ".ps1",
        ".bat",
        ".cmd",
    ]);
    private readonly webCodeExtensions = new Set<string>([
        ".html",
        ".htm",
        ".css",
        ".scss",
        ".sass",
        ".less",
        ".styl",
    ]);
    private readonly functionalConfigExtensions = new Set<string>([
        ".sql",
        ".graphql",
        ".gql",
        ".proto",
        ".thrift",
    ]);
    private readonly essentialConfigFiles = new Set<string>(
        [
            "package.json",
            "composer.json",
            "cargo.toml",
            "pyproject.toml",
            "setup.py",
            "requirements.txt",
            "gemfile",
            "podfile",
            "build.gradle",
            "pom.xml",
            "makefile",
            "dockerfile",
            "docker-compose.yml",
            "docker-compose.yaml",
            "docker-compose.dev.yml",
            "docker-compose.prod.yml",
            "docker-compose.test.yml",
            "webpack.config.js",
            "webpack.config.ts",
            "vite.config.js",
            "vite.config.ts",
            "rollup.config.js",
            "rollup.config.ts",
            "jest.config.js",
            "jest.config.ts",
            "babel.config.js",
            "babel.config.json",
            "tsconfig.json",
            "jsconfig.json",
            ".eslintrc.js",
            ".eslintrc.json",
            "tailwind.config.js",
            "tailwind.config.ts",
            "next.config.js",
            "nuxt.config.js",
            "vue.config.js",
            "angular.json",
            "ember-cli-build.js",
        ].map((name) => name.toLowerCase())
    );
    private readonly skippedKeywords = new Set<string>([
        "if",
        "for",
        "while",
        "try",
        "catch",
        "finally",
        "switch",
        "case",
    ]);

    // ts-morph configuration constants
    private static readonly TIME_BUDGET_MS_PER_FILE = 200;
    private static readonly MAX_ELEMS_PER_FILE = 500;
    private static readonly MAX_FILE_BYTES = 400 * 1024; // 400KB
    private static readonly MAX_CACHED_FILES = 50;
    private static readonly MAX_CACHE_BYTES = 25 * 1024 * 1024; // 25MB

    // ts-morph instance management
    private tsMorphProject?: Project;
    private tsMorphInitialized = false;
    private tsMorphWorkspaceRoot?: string;
    private readonly sourceFileCache = new Map<string, { sourceFile: SourceFile; size: number }>();
    private cachedBytes = 0;
    private tsMorphParserUsage = {
        parserUsed: 'none' as 'ts-morph' | 'regex',
        filesParsed: 0,
        fellBackToRegex: 0,
        timedOutFiles: 0,
    };

    private readonly extensionRoot?: string;

    constructor(extensionRoot?: string) {
        this.extensionRoot = extensionRoot;
        // Always use workspace root for code scanning, not extension root
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
        this.ignorePatterns = this.ignorePatternSources.map(
            (pattern) => new RegExp(pattern, "i")
        );
    }

    public detectLanguage(filePath: string): string | null {
        const normalized = this.normalizePath(filePath);
        for (const [language, pattern] of this.languagePatterns) {
            if (pattern.test(normalized)) {
                return language;
            }
        }
        return null;
    }

    public shouldIgnoreFile(filePath: string): boolean {
        const normalized = this.normalizePath(filePath);
        for (const pattern of this.ignorePatterns) {
            if (pattern.test(normalized)) {
                return true;
            }
        }
        return this.isInVirtualEnvironment(normalized);
    }

    public isFunctionalCodeFile(filePath: string): boolean {
        const extension = path.extname(filePath).toLowerCase();

        if (this.coreCodeExtensions.has(extension)) {
            return true;
        }

        if (this.secondaryCodeExtensions.has(extension)) {
            return true;
        }

        if (this.webCodeExtensions.has(extension)) {
            return true;
        }

        if (this.functionalConfigExtensions.has(extension)) {
            return true;
        }

        const fileName = path.basename(filePath).toLowerCase();
        return this.essentialConfigFiles.has(fileName);
    }

    /**
     * Check if language is JavaScript or TypeScript
     */
    private isJavaScriptOrTypeScript(language: string): boolean {
        const lang = language.toLowerCase();
        return lang === 'javascript' || lang === 'typescript' || lang === 'jsx' || lang === 'tsx';
    }

    /**
     * Find tsconfig.json in workspace root or parent directories
     */
    private findTsConfigPath(workspaceRoot: string): string | undefined {
        const candidates = [
            path.join(workspaceRoot, 'tsconfig.json'),
            path.join(workspaceRoot, 'jsconfig.json'),
        ];

        for (const candidate of candidates) {
            try {
                if (existsSync(candidate) && statSync(candidate).isFile()) {
                    return candidate;
                }
            } catch {
                // Continue searching
            }
        }

        // Try parent directories (up to 3 levels)
        let current = workspaceRoot;
        for (let i = 0; i < 3; i++) {
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;

            const parentTsConfig = path.join(current, 'tsconfig.json');
            try {
                if (existsSync(parentTsConfig) && statSync(parentTsConfig).isFile()) {
                    return parentTsConfig;
                }
            } catch {
                // Continue
            }
        }

        return undefined;
    }

    /**
     * Initialize ts-morph Project with lightweight configuration
     */
    private initializeTsMorphProject(workspaceRoot: string): void {
        if (this.tsMorphInitialized && this.tsMorphProject && this.tsMorphWorkspaceRoot === workspaceRoot) {
            return;
        }

        try {
            const tsConfigPath = this.findTsConfigPath(workspaceRoot);
            const hasTsConfig = !!tsConfigPath;

            this.tsMorphProject = new Project({
                tsConfigFilePath: tsConfigPath ?? undefined,
                skipAddingFilesFromTsConfig: !hasTsConfig,
                compilerOptions: {
                    allowJs: true,
                    checkJs: false,
                    skipLibCheck: true,
                    noResolve: true, // Critical: avoid dependency crawling
                    target: ts.ScriptTarget.ES2020,
                    module: ts.ModuleKind.ESNext,
                    moduleResolution: ts.ModuleResolutionKind.NodeNext,
                    jsx: ts.JsxEmit.ReactJSX,
                },
            });

            this.tsMorphInitialized = true;
            this.tsMorphWorkspaceRoot = workspaceRoot;
            this.sourceFileCache.clear();
            this.cachedBytes = 0;
        } catch (error) {
            console.warn(`[CodeParserService] Failed to initialize ts-morph project:`, error);
            // Create fallback project without tsconfig
            this.tsMorphProject = new Project({
                compilerOptions: {
                    allowJs: true,
                    checkJs: false,
                    skipLibCheck: true,
                    noResolve: true,
                    target: ts.ScriptTarget.ES2020,
                    module: ts.ModuleKind.ESNext,
                    moduleResolution: ts.ModuleResolutionKind.NodeNext,
                    jsx: ts.JsxEmit.ReactJSX,
                },
            });
            this.tsMorphInitialized = true;
            this.tsMorphWorkspaceRoot = workspaceRoot;
        }
    }

    /**
     * Manage LRU cache for SourceFiles
     */
    private manageSourceFileCache(filePath: string, sourceFile: SourceFile, fileSize: number): void {
        // Check if we need to evict files
        while (
            (this.sourceFileCache.size >= CodeParserService.MAX_CACHED_FILES ||
                this.cachedBytes + fileSize > CodeParserService.MAX_CACHE_BYTES) &&
            this.sourceFileCache.size > 0
        ) {
            // Remove oldest entry (simple FIFO strategy)
            const firstKey = this.sourceFileCache.keys().next().value;
            if (firstKey) {
                const oldEntry = this.sourceFileCache.get(firstKey);
                if (oldEntry && this.tsMorphProject) {
                    oldEntry.sourceFile.forget();
                    this.tsMorphProject.removeSourceFile(oldEntry.sourceFile);
                    this.cachedBytes = Math.max(0, this.cachedBytes - oldEntry.size);
                }
                this.sourceFileCache.delete(firstKey);
            }
        }

        // Add new file to cache
        if (!this.sourceFileCache.has(filePath)) {
            this.sourceFileCache.set(filePath, { sourceFile, size: fileSize });
            this.cachedBytes += fileSize;
        }
    }

    /**
     * Get or create SourceFile from ts-morph Project, with cache management
     */
    private async getOrCreateSourceFile(filePath: string, workspaceRoot: string): Promise<SourceFile | null> {
        // Check file size
        try {
            const stat = await fsPromises.stat(filePath);
            if (stat.size > CodeParserService.MAX_FILE_BYTES) {
                throw new Error("TSMORPH_FILE_TOO_LARGE");
            }

            // Initialize project if needed
            this.initializeTsMorphProject(workspaceRoot);
            if (!this.tsMorphProject) {
                return null;
            }

            // Check if already cached
            const cached = this.sourceFileCache.get(filePath);
            if (cached) {
                return cached.sourceFile;
            }

            // Try to get existing file from project
            let sourceFile = this.tsMorphProject.getSourceFile(filePath);
            if (sourceFile) {
                this.manageSourceFileCache(filePath, sourceFile, stat.size);
                return sourceFile;
            }

            // Check if file should be ignored (node_modules, build output)
            const normalizedPath = this.normalizePath(filePath);
            if (this.shouldIgnoreFile(normalizedPath)) {
                return null;
            }

            // Try to get from VS Code editor buffer first (for dirty files)
            let fileContent: string | null = null;
            try {
                const uri = vscode.Uri.file(filePath);
                const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filePath);
                if (document && !document.isClosed) {
                    fileContent = document.getText();
                }
            } catch {
                // Fall back to reading from disk
            }

            // Read file content if not from editor
            if (!fileContent) {
                fileContent = await this.readFileContent(filePath);
            }

            if (!fileContent) {
                return null;
            }

            // Create source file
            sourceFile = this.tsMorphProject.createSourceFile(filePath, fileContent, { overwrite: true });
            this.manageSourceFileCache(filePath, sourceFile, stat.size);

            return sourceFile;
        } catch (error) {
            if ((error as Error).message === "TSMORPH_FILE_TOO_LARGE") {
                throw error;
            }
            console.warn(`[CodeParserService] Failed to get/create source file for ${filePath}:`, error);
            return null;
        }
    }

    /**
     * Extract signature up to first '{' or '=' while balancing parentheses/brackets/braces
     */
    private extractSignatureUpToBraceOrEquals(text: string): string {
        let depth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let inString = false;
        let stringChar: string | null = null;
        let i = 0;

        for (; i < text.length; i++) {
            const char = text[i];
            const prevChar = i > 0 ? text[i - 1] : null;

            // Handle string literals
            if (!inString && (char === '"' || char === "'" || char === '`')) {
                inString = true;
                stringChar = char;
                continue;
            } else if (inString && char === stringChar && prevChar !== '\\') {
                inString = false;
                stringChar = null;
                continue;
            }

            if (inString) {
                continue;
            }

            // Track depth for parentheses, brackets, and braces
            if (char === '(') {
                depth++;
            } else if (char === ')') {
                depth--;
            } else if (char === '[') {
                bracketDepth++;
            } else if (char === ']') {
                bracketDepth--;
            } else if (char === '{') {
                braceDepth++;
                // Stop at first opening brace if all parentheses/brackets are balanced
                if (depth === 0 && bracketDepth === 0 && braceDepth === 1) {
                    return text.slice(0, i).trim();
                }
            } else if (char === '}') {
                braceDepth--;
            } else if (char === '=' && depth === 0 && bracketDepth === 0 && braceDepth === 0) {
                // Stop at first '=' if all delimiters are balanced (for constants)
                return text.slice(0, i).trim();
            }
        }

        // If no '{' or '=' found, return trimmed text
        return text.trim();
    }

    /**
     * Extract function signature using ts-morph AST
     */
    private extractFunctionSignature(node: Node): string {
        if (!Node.isFunctionDeclaration(node)) {
            return '';
        }

        const name = node.getName();
        if (!name) {
            return '';
        }

        const parts: string[] = ['function', name];

        // Add type parameters
        const typeParams = node.getTypeParameters();
        if (typeParams.length > 0) {
            const typeParamsText = typeParams.map(tp => tp.getText()).join(', ');
            parts.push(`<${typeParamsText}>`);
        }

        // Add parameters
        const params = node.getParameters();
        const paramsText = params.map(p => p.getText()).join(', ');
        parts.push(`(${paramsText})`);

        // Add return type
        const returnType = node.getReturnTypeNode();
        if (returnType) {
            parts.push(`: ${returnType.getText()}`);
        }

        return parts.join(' ');
    }

    /**
     * Extract method signature using ts-morph AST
     */
    private extractMethodSignature(node: Node): string {
        if (!Node.isMethodDeclaration(node)) {
            return '';
        }

        const parts: string[] = [];

        // Add accessibility modifiers
        if (node.getScope() !== undefined) {
            const scope = node.getScope();
            if (scope === 'public') parts.push('public');
            else if (scope === 'private') parts.push('private');
            else if (scope === 'protected') parts.push('protected');
        }

        // Add static/abstract/async keywords
        if (node.isStatic()) parts.push('static');
        if (node.isAbstract()) parts.push('abstract');
        if (node.isAsync()) parts.push('async');

        const name = node.getName();
        parts.push(name);

        // Add type parameters
        const typeParams = node.getTypeParameters();
        if (typeParams.length > 0) {
            const typeParamsText = typeParams.map(tp => tp.getText()).join(', ');
            parts.push(`<${typeParamsText}>`);
        }

        // Add parameters
        const params = node.getParameters();
        const paramsText = params.map(p => p.getText()).join(', ');
        parts.push(`(${paramsText})`);

        // Add return type
        const returnType = node.getReturnTypeNode();
        if (returnType) {
            parts.push(`: ${returnType.getText()}`);
        }

        return parts.join(' ');
    }

    /**
     * Extract class signature using ts-morph AST
     */
    private extractClassSignature(node: Node): string {
        if (!Node.isClassDeclaration(node)) {
            return '';
        }

        const name = node.getName();
        if (!name) {
            return '';
        }

        const parts: string[] = ['class', name];

        // Add type parameters
        const typeParams = node.getTypeParameters();
        if (typeParams.length > 0) {
            const typeParamsText = typeParams.map(tp => tp.getText()).join(', ');
            parts.push(`<${typeParamsText}>`);
        }

        // Add extends clause
        const extendsClause = node.getExtends();
        if (extendsClause) {
            parts.push('extends', extendsClause.getText());
        }

        // Add implements clause
        const implementsClauses = node.getImplements();
        if (implementsClauses.length > 0) {
            const implementsText = implementsClauses.map(impl => impl.getText()).join(', ');
            parts.push('implements', implementsText);
        }

        return parts.join(' ');
    }

    /**
     * Extract interface signature using ts-morph AST
     */
    private extractInterfaceSignature(node: Node): string {
        if (!Node.isInterfaceDeclaration(node)) {
            return '';
        }

        const name = node.getName();
        if (!name) {
            return '';
        }

        const parts: string[] = ['interface', name];

        // Add type parameters
        const typeParams = node.getTypeParameters();
        if (typeParams.length > 0) {
            const typeParamsText = typeParams.map(tp => tp.getText()).join(', ');
            parts.push(`<${typeParamsText}>`);
        }

        // Add extends clause
        const extendsClauses = node.getExtends();
        if (extendsClauses.length > 0) {
            const extendsText = extendsClauses.map(ext => ext.getText()).join(', ');
            parts.push('extends', extendsText);
        }

        return parts.join(' ');
    }

    /**
     * Extract type alias signature using ts-morph AST
     */
    private extractTypeAliasSignature(node: Node): string {
        if (!Node.isTypeAliasDeclaration(node)) {
            return '';
        }

        const name = node.getName();
        if (!name) {
            return '';
        }

        const parts: string[] = ['type', name];

        // Add type parameters
        const typeParams = node.getTypeParameters();
        if (typeParams.length > 0) {
            const typeParamsText = typeParams.map(tp => tp.getText()).join(', ');
            parts.push(`<${typeParamsText}>`);
        }

        // Add type node
        const typeNode = node.getTypeNode();
        if (typeNode) {
            // Get full type text (can be multi-line)
            const typeText = typeNode.getText();
            parts.push('=', typeText);
        }

        return parts.join(' ');
    }

    /**
     * Extract enum signature
     */
    private extractEnumSignature(node: Node): string {
        if (!Node.isEnumDeclaration(node)) {
            return '';
        }

        const name = node.getName();
        if (!name) {
            return '';
        }

        return `enum ${name}`;
    }

    /**
     * Extract arrow function signature using text slicing to preserve multi-line parameters
     */
    private extractArrowFunctionSignature(node: Node): string {
        if (!Node.isVariableDeclaration(node)) {
            return '';
        }

        const nameNode = node.getNameNode();
        if (!nameNode) {
            return '';
        }

        const nodeText = node.getText();
        const initializer = node.getInitializer();
        
        if (initializer && Node.isArrowFunction(initializer)) {
            // Extract signature up to '=>' while balancing parentheses/brackets/braces
            // This preserves multi-line parameter lists
            let depth = 0;
            let bracketDepth = 0;
            let braceDepth = 0;
            let inString = false;
            let stringChar: string | null = null;

            for (let i = 0; i < nodeText.length; i++) {
                const char = nodeText[i];
                const prevChar = i > 0 ? nodeText[i - 1] : null;

                // Handle string literals
                if (!inString && (char === '"' || char === "'" || char === '`')) {
                    inString = true;
                    stringChar = char;
                    continue;
                } else if (inString && char === stringChar && prevChar !== '\\') {
                    inString = false;
                    stringChar = null;
                    continue;
                }

                if (inString) {
                    continue;
                }

                // Track depth for parentheses, brackets, and braces
                if (char === '(') {
                    depth++;
                } else if (char === ')') {
                    depth--;
                } else if (char === '[') {
                    bracketDepth++;
                } else if (char === ']') {
                    bracketDepth--;
                } else if (char === '{') {
                    braceDepth++;
                } else if (char === '}') {
                    braceDepth--;
                } else if (char === '=' && i < nodeText.length - 1 && nodeText[i + 1] === '>') {
                    // Found '=>' - stop here and include it
                    if (depth === 0 && bracketDepth === 0 && braceDepth === 0) {
                        return nodeText.substring(0, i + 2).trim();
                    }
                }
            }
        }

        // Fallback: use text slicing up to first '=' or '{'
        return this.extractSignatureUpToBraceOrEquals(nodeText);
    }

    /**
     * Extract constant signature using text slicing
     */
    private extractConstantSignature(node: Node): string {
        if (!Node.isVariableDeclaration(node)) {
            return '';
        }

        const nameNode = node.getNameNode();
        if (!nameNode) {
            return '';
        }

        const name = nameNode.getText();
        const nodeText = node.getText();

        // Extract up to first '=' while preserving type annotations
        return this.extractSignatureUpToBraceOrEquals(nodeText);
    }

    /**
     * Extract code elements using ts-morph parsing
     */
    private async extractElementsWithTsMorph(
        filePath: string,
        language: string
    ): Promise<CodeElement[]> {
        try {
            if (!this.workspaceRoot) {
                return [];
            }

            // Get or create source file
            const sourceFile = await this.getOrCreateSourceFile(filePath, this.workspaceRoot);
            if (!sourceFile) {
                return [];
            }

            const elements: CodeElement[] = [];
            const fileContent = sourceFile.getFullText();
            const lines = fileContent.split(/\r?\n/);

            // Record start time for time budget enforcement
            const startTime = Date.now();

            // Traverse all descendants to extract elements
            sourceFile.forEachDescendant((node) => {
                // Check time budget - return false to stop traversal
                const elapsedTime = Date.now() - startTime;
                if (elapsedTime > CodeParserService.TIME_BUDGET_MS_PER_FILE) {
                    return false;
                }

                // Check element count budget - return false to stop traversal
                if (elements.length >= CodeParserService.MAX_ELEMS_PER_FILE) {
                    return false;
                }

                try {
                    let elementType: CodeElementType | null = null;
                    let name: string | null = null;
                    let signature: string | null = null;

                    // Extract functions
                    if (Node.isFunctionDeclaration(node)) {
                        const nameNode = node.getNameNode();
                        if (nameNode) {
                            name = nameNode.getText();
                            elementType = 'function';
                            signature = this.extractFunctionSignature(node);
                        }
                    }
                    // Extract classes
                    else if (Node.isClassDeclaration(node)) {
                        const nameNode = node.getNameNode();
                        if (nameNode) {
                            name = nameNode.getText();
                            elementType = 'class';
                            signature = this.extractClassSignature(node);
                        }
                    }
                    // Extract methods
                    else if (Node.isMethodDeclaration(node)) {
                        const nameNode = node.getNameNode();
                        if (nameNode) {
                            name = nameNode.getText();
                            elementType = 'method';
                            signature = this.extractMethodSignature(node);
                        }
                    }
                    // Extract interfaces
                    else if (Node.isInterfaceDeclaration(node)) {
                        const nameNode = node.getNameNode();
                        if (nameNode) {
                            name = nameNode.getText();
                            elementType = 'interface';
                            signature = this.extractInterfaceSignature(node);
                        }
                    }
                    // Extract type aliases
                    else if (Node.isTypeAliasDeclaration(node)) {
                        const nameNode = node.getNameNode();
                        if (nameNode) {
                            name = nameNode.getText();
                            elementType = 'type_definition';
                            signature = this.extractTypeAliasSignature(node);
                        }
                    }
                    // Extract enums
                    else if (Node.isEnumDeclaration(node)) {
                        const nameNode = node.getNameNode();
                        if (nameNode) {
                            name = nameNode.getText();
                            elementType = 'enum';
                            signature = this.extractEnumSignature(node);
                        }
                    }
                    // Extract arrow functions and constants from variable declarations
                    else if (Node.isVariableDeclaration(node)) {
                        const nameNode = node.getNameNode();
                        if (!nameNode) {
                            return;
                        }

                        const initializer = node.getInitializer();
                        const nameText = nameNode.getText();
                        
                        // Check if it's an arrow function
                        if (initializer && Node.isArrowFunction(initializer)) {
                            name = nameText;
                            elementType = 'arrow_function';
                            signature = this.extractArrowFunctionSignature(node);
                        }
                        // Check if it's a constant (UPPER_CASE naming)
                        else if (/^[A-Z][A-Z0-9_]*$/.test(nameText)) {
                            name = nameText;
                            elementType = 'constant';
                            signature = this.extractConstantSignature(node);
                        } else {
                            return; // Skip regular variable declarations
                        }
                    }

                    // Skip if we didn't identify an element or name is missing
                    if (!elementType || !name || this.skippedKeywords.has(name)) {
                        return;
                    }

                    // Re-check budgets before processing to avoid partial node work
                    const elapsedTimeBeforeProcessing = Date.now() - startTime;
                    if (elapsedTimeBeforeProcessing > CodeParserService.TIME_BUDGET_MS_PER_FILE) {
                        return false;
                    }

                    if (elements.length >= CodeParserService.MAX_ELEMS_PER_FILE) {
                        return false;
                    }

                    // Get line numbers (ts-morph uses 1-based indexing)
                    const lineStart = node.getStartLineNumber();
                    const lineEnd = node.getEndLineNumber();

                    // Extract code snippet
                    const codeSnippet = node.getText();

                    // Get signature from first line if not already set
                    if (!signature && lineStart > 0 && lineStart <= lines.length) {
                        signature = lines[lineStart - 1];
                    }

                    // Extract documentation
                    const documentation = this.documentationExtractor.extractDocumentation(lines, lineStart - 1, language);
                    const inlineComments = this.documentationExtractor.extractInlineComments(codeSnippet, language);
                    if (documentation && inlineComments.length > 0) {
                        documentation.inlineComments = inlineComments;
                    }

                    // Final check before pushing to ensure we don't exceed limits
                    if (elements.length < CodeParserService.MAX_ELEMS_PER_FILE) {
                        elements.push({
                            name,
                            type: elementType,
                            lineStart,
                            lineEnd,
                            filePath,
                            signature: signature || '',
                            codeSnippet,
                            documentation: documentation && Object.keys(documentation).length > 0 ? documentation : undefined,
                        });
                    } else {
                        return false; // Stop traversal if we've reached the limit
                    }
                } catch (error) {
                    // Skip this node if there's an error extracting it
                    console.warn(`Error extracting element from node in ${filePath}:`, error);
                }
            });

            return elements;
        } catch (error) {
            console.error(`ts-morph parsing failed for ${filePath} (${language}):`, error);
            throw error;
        }
    }

    public async extractElementsFromFile(
        filePath: string,
        language: string
    ): Promise<CodeElement[]> {
        try {
            // First attempt: Use ts-morph parsing for TypeScript/JavaScript files
            if (this.isJavaScriptOrTypeScript(language)) {
                try {
                    const elements = await this.extractElementsWithTsMorph(filePath, language);
                    if (elements.length > 0) {
                        this.tsMorphParserUsage.parserUsed = 'ts-morph';
                        this.tsMorphParserUsage.filesParsed++;
                        return elements;
                    }
                } catch (error) {
                    console.warn(`ts-morph parsing failed for ${filePath} (${language}), falling back to regex:`, error);
                    this.tsMorphParserUsage.fellBackToRegex++;
                }
            }

            // Fallback: Use regex-based parsing
            this.tsMorphParserUsage.parserUsed = 'regex';
            return await this.extractElementsWithRegex(filePath, language);
        } catch (error) {
            console.error(`Error extracting elements from ${filePath} (${language}):`, error);
            // Final fallback to regex parsing
            return await this.extractElementsWithRegex(filePath, language);
        }
    }

    public async scanCodebase(
        rootPath?: string,
        maxFiles = 10000
    ): Promise<Map<string, FileInfo>> {
        if (maxFiles <= 0) {
            return new Map();
        }

        const resolvedRoot = await this.resolveRootPath(rootPath);
        if (!resolvedRoot) {
            throw new Error("No valid workspace root available for scanning.");
        }

        const fileInfos = new Map<string, FileInfo>();
        const files = await this.collectFiles(vscode.Uri.file(resolvedRoot), maxFiles);

        for (const fileUri of files) {
            if (fileInfos.size >= maxFiles) {
                break;
            }

            const filePath = fileUri.fsPath;

            if (!this.isFunctionalCodeFile(filePath)) {
                continue;
            }

            const language = this.detectLanguage(filePath);
            if (!language) {
                continue;
            }

            try {
                const stat = await vscode.workspace.fs.stat(fileUri);
                const elements = await this.extractElementsFromFile(filePath, language);

                // Ensure elements array is populated with comprehensive code analysis
                const enrichedElements = await this.enrichCodeElements(elements, filePath, language);

                // Phase 3: Build relationships for this file
                const relationships = this.buildFileRelationships(enrichedElements, language);

                // Phase 6: Detect patterns in this file
                const patterns = this.patternDetector.detectPatterns(filePath, enrichedElements, language);

                // Phase 8: Analyze exports
                const fileContent = await this.readFileContent(filePath);
                const exports = fileContent ? this.exportAnalyzer.analyzeExports(fileContent, filePath, language) : undefined;
                const moduleBoundary = fileContent && this.exportAnalyzer.isBarrelFile(fileContent, filePath, language) ? {
                    isBarrelFile: true,
                    modulePath: path.dirname(filePath),
                    exportsFromFiles: exports?.filter(e => e.type === 're-export').map(e => e.from).filter((f): f is string => !!f),
                } : undefined;

                fileInfos.set(filePath, {
                    path: filePath,
                    name: path.basename(filePath),
                    extension: path.extname(filePath),
                    language,
                    size: stat.size,
                    elements: enrichedElements,
                    lastModified: new Date(stat.mtime),
                    relationships, // Phase 3: Add relationships
                    patterns, // Phase 6: Add pattern detection
                    exports, // Phase 8: Add exports
                    moduleBoundary, // Phase 8: Add module boundary info
                });
            } catch (error) {
                console.warn(`Error processing file ${filePath}:`, error);
            }
        }

        return fileInfos;
    }

    public async getRelevantFiles(
        fileInfos: Map<string, FileInfo>,
        query: string,
        maxResults = 30,
        projectId?: string
    ): Promise<string[]> {
        if (!fileInfos.size || !query.trim()) {
            return [];
        }

        const llmSelection = await this.identifyRelevantFilesWithLLM(
            fileInfos,
            query,
            projectId
        );

        if (!llmSelection.size) {
            return this.rankByHeuristics(fileInfos, query, maxResults);
        }

        const ranked: string[] = [];
        for (const [filePath] of llmSelection) {
            if (fileInfos.has(filePath)) {
                ranked.push(filePath);
            }
        }

        if (ranked.length < maxResults) {
            const remaining = this.rankByHeuristics(fileInfos, query, maxResults)
                .filter((path) => !ranked.includes(path));
            ranked.push(...remaining);
        }

        return ranked.slice(0, maxResults);
    }

    private async identifyRelevantFilesWithLLM(
        fileInfos: Map<string, FileInfo>,
        query: string,
        projectId?: string
    ): Promise<Map<string, string[]>> {
        if (!this.llmProvider) {
            return new Map();
        }

        try {
            const promptText = await this.loadPrompt("codeParser/step2_identify_relevant_elements.md");
            const message = this.buildLLMMessage(promptText, query, fileInfos);

            const request: LLMRequest = {
                id: `code-parser-${Date.now()}`,
                provider: "auto",
                model: "",
                messages: message,
                metadata: {
                    projectId,
                    purpose: "code_parser_relevance",
                },
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const response = await this.llmProvider.chat(request);
            if (response.type !== ResponseType.SUCCESS || !response.payload) {
                return new Map();
            }

            const payload = response.payload as LLMResponse;
            return this.parseLLMSelection(payload.content, fileInfos);
        } catch (error) {
            console.warn("CodeParserService: LLM-assisted relevance selection failed", error);
            return new Map();
        }
    }

    protected rankByHeuristics(
        fileInfos: Map<string, FileInfo>,
        query: string,
        maxResults: number
    ): string[] {
        const queryLower = query.toLowerCase();
        const scored: Array<{ path: string; score: number }> = [];

        for (const [filePath, info] of fileInfos.entries()) {
            let score = 0;

            if (info.name.toLowerCase().includes(queryLower)) {
                score += 3;
            }

            for (const element of info.elements) {
                if (element.name.toLowerCase().includes(queryLower)) {
                    score += 2;
                }
            }

            if (filePath.toLowerCase().includes(queryLower)) {
                score += 1;
            }

            if (score > 0) {
                scored.push({ path: filePath, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, maxResults).map((item) => item.path);
    }

    public async loadPrompt(relativePath: string): Promise<string> {
        const cached = this.promptCache.get(relativePath);
        if (cached) {
            return cached;
        }

        const candidates = this.getPromptCandidates(relativePath);

        for (const candidate of candidates) {
            try {
                const content = await fsPromises.readFile(candidate, "utf-8");
                this.promptCache.set(relativePath, content);
                return content;
            } catch (error) {
                continue;
            }
        }

        throw new Error(`Prompt not found for ${relativePath}`);
    }

    private getPromptCandidates(relativePath: string): string[] {
        const candidates: string[] = [];
        
        // In packaged extensions, __dirname points to the dist directory
        // Check the extension's dist/prompts directory first (for packaged extensions)
        const extensionDistPrompts = path.join(__dirname, "..", "..", "dist", "prompts", relativePath);
        candidates.push(extensionDistPrompts);
        
        // Check extension's out/prompts directory (for development)
        const extensionOutPrompts = path.join(__dirname, "..", "..", "out", "prompts", relativePath);
        candidates.push(extensionOutPrompts);
        
        // Check extension's src/agent/prompts directory (for development)
        const extensionSrcPrompts = path.join(__dirname, "..", "..", "src", "agent", "prompts", relativePath);
        candidates.push(extensionSrcPrompts);
        
        // Check workspace root directories (for development)
        const workspaceRootFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (workspaceRootFolder) {
            const basePath = workspaceRootFolder.fsPath;
            candidates.push(path.join(basePath, "dist", "prompts", relativePath));
            candidates.push(path.join(basePath, "src", "agent", "prompts", relativePath));
        }

        // Check extension root if provided
        if (this.extensionRoot) {
            candidates.push(path.join(this.extensionRoot, "dist", "prompts", relativePath));
            candidates.push(path.join(this.extensionRoot, "out", "prompts", relativePath));
            candidates.push(path.join(this.extensionRoot, "prompts", relativePath));
            candidates.push(path.join(this.extensionRoot, "src", "agent", "prompts", relativePath));
        }

        // Legacy fallback paths
        candidates.push(path.join(__dirname, "..", "prompts", relativePath));
        candidates.push(path.join(__dirname, "..", "..", "prompts", relativePath));

        return candidates;
    }

    private buildLLMMessage(
        promptTemplate: string,
        query: string,
        fileInfos: Map<string, FileInfo>
    ): LLMMessage[] {
        const summary = this.buildFileElementsSummary(fileInfos);
        const content = promptTemplate
            .replace("{{USER_REQUEST}}", query)
            .replace("{{FILE_ELEMENTS_SUMMARY}}", summary);

        return [{ role: "system", content }];
    }

    private buildFileElementsSummary(fileInfos: Map<string, FileInfo>): string {
        const parts: string[] = [];

        for (const info of fileInfos.values()) {
            const header = `📁 ${info.path} (${info.language}):`;
            const elements = info.elements.length
                ? info.elements.map((element) => `  • ${element.type}: ${element.name}`).join("\n")
                : "  • no elements";

            parts.push(`${header}\n${elements}`);
        }

        return parts.join("\n\n");
    }

    private parseLLMSelection(
        response: string,
        fileInfos: Map<string, FileInfo>
    ): Map<string, string[]> {
        const selection = new Map<string, string[]>();

        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return selection;
            }

            const parsed = JSON.parse(jsonMatch[0]) as RelevantFileSelection;
            for (const [filePath, methods] of Object.entries(parsed)) {
                const resolvedPath = this.resolveFilePath(filePath, fileInfos);
                if (!resolvedPath) {
                    continue;
                }

                const normalizedMethods = Array.isArray(methods)
                    ? methods.filter((item) => typeof item === "string")
                    : [];

                selection.set(resolvedPath, normalizedMethods);
            }
        } catch (error) {
            console.warn("CodeParserService: failed to parse LLM selection", error);
        }

        return selection;
    }

    private resolveFilePath(
        candidate: string,
        fileInfos: Map<string, FileInfo>
    ): string | undefined {
        if (fileInfos.has(candidate)) {
            return candidate;
        }

        const normalizedCandidate = candidate.replace(/\\/g, "/").toLowerCase();

        for (const filePath of fileInfos.keys()) {
            const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();

            if (
                normalizedPath === normalizedCandidate ||
                normalizedPath.endsWith(normalizedCandidate) ||
                path.basename(normalizedPath) === normalizedCandidate
            ) {
                return filePath;
            }
        }

        return undefined;
    }

    private normalizePath(filePath: string): string {
        return filePath.replace(/\\/g, "/");
    }

    private isInVirtualEnvironment(filePath: string): boolean {
        const parts = filePath.split("/").filter((segment) => segment.length > 0);

        for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index];

            if (part === "site-packages" || part === "dist-packages") {
                return true;
            }

            if (/python\d+\.\d+/i.test(part)) {
                if (
                    index + 1 < parts.length &&
                    (parts[index + 1] === "site-packages" || parts[index + 1] === "dist-packages")
                ) {
                    return true;
                }
            }

            if ((part === "lib" || part === "lib64") && index + 2 < parts.length) {
                if (
                    /python\d+\.\d+/i.test(parts[index + 1]) &&
                    (parts[index + 2] === "site-packages" || parts[index + 2] === "dist-packages")
                ) {
                    return true;
                }
            }
        }

        return false;
    }

    private async resolveRootPath(rootPath?: string): Promise<string | null> {
        if (rootPath) {
            const resolved = path.resolve(rootPath);
            try {
                const stat = await vscode.workspace.fs.stat(vscode.Uri.file(resolved));
                if ((stat.type & vscode.FileType.Directory) !== 0) {
                    return resolved;
                }
                console.warn(
                    `CodeParserService: provided root path is not a directory: ${resolved}`
                );
                return null;
            } catch (error) {
                console.warn(
                    `CodeParserService: unable to access provided root path: ${resolved}`,
                    error
                );
                return null;
            }
        }

        return this.workspaceRoot;
    }

    private async collectFiles(root: vscode.Uri, maxFiles: number): Promise<vscode.Uri[]> {
        const collected: vscode.Uri[] = [];
        const queue: vscode.Uri[] = [root];

        while (queue.length > 0 && collected.length < maxFiles) {
            const current = queue.shift()!;
            let entries: [string, vscode.FileType][];

            try {
                entries = await vscode.workspace.fs.readDirectory(current);
            } catch (error) {
                console.warn(`Error reading directory ${current.fsPath}:`, error);
                continue;
            }

            for (const [name, type] of entries) {
                if (collected.length >= maxFiles) {
                    break;
                }

                const childUri = vscode.Uri.joinPath(current, name);
                const childPath = this.normalizePath(childUri.fsPath);

                if (this.shouldIgnoreFile(childPath)) {
                    continue;
                }

                const isDirectory = (type & vscode.FileType.Directory) !== 0;
                const isFile = (type & vscode.FileType.File) !== 0;

                if (isDirectory) {
                    queue.push(vscode.Uri.file(childPath));
                } else if (isFile) {
                    collected.push(vscode.Uri.file(childPath));
                }
            }
        }

        return collected;
    }

    private async readFileLines(filePath: string): Promise<string[] | null> {
        try {
            // Try VS Code API first (preferred in extension runtime)
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
            const content = textDecoder.decode(data);
            const lines = content.split(/\r?\n/);
            
            // Fallback to Node fs if VS Code API returns empty/invalid result (e.g., in tests)
            if (lines.length <= 1 && lines[0] === '') {
                console.log(`[CodeParserService] VS Code API returned empty, falling back to Node fs for: ${filePath}`);
                const fsContent = await fsPromises.readFile(filePath, 'utf-8');
                return fsContent.split(/\r?\n/);
            }
            
            return lines;
        } catch (error) {
            // If VS Code API fails, try Node fs as fallback
            try {
                const fsContent = await fsPromises.readFile(filePath, 'utf-8');
                return fsContent.split(/\r?\n/);
            } catch (fsError) {
                console.warn(`Error reading file ${filePath}:`, error);
                return null;
            }
        }
    }

    private extractUsingPatterns(
        lines: string[],
        filePath: string,
        patterns: Record<string, RegExp>
    ): CodeElement[] {
        const elements: CodeElement[] = [];
        const language = this.detectLanguage(filePath) || 'unknown';

        lines.forEach((line, index) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
                return;
            }

            for (const [elementType, pattern] of Object.entries(patterns)) {
                const match = trimmed.match(pattern);
                if (!match) {
                    continue;
                }

                const name = match[1];
                if (!name || this.skippedKeywords.has(name)) {
                    continue;
                }

                // Estimate lineEnd by finding the end of the element
                const lineEnd = this.estimateElementEnd(lines, index, elementType);

                // Extract code snippet
                const codeSnippet = lines.slice(index, lineEnd).join('\n');

                // Phase 2: Extract documentation
                const documentation = this.documentationExtractor.extractDocumentation(lines, index, language);

                // Phase 2: Extract inline comments from snippet
                const inlineComments = this.documentationExtractor.extractInlineComments(codeSnippet, language);
                if (documentation && inlineComments.length > 0) {
                    documentation.inlineComments = inlineComments;
                }

                elements.push({
                    name,
                    type: elementType as CodeElementType,
                    lineStart: index + 1,
                    lineEnd: lineEnd + 1,
                    filePath,
                    signature: trimmed,
                    codeSnippet,
                    documentation,
                });

                break;
            }
        });

        return elements;
    }

    private extractPythonElements(lines: string[], filePath: string): CodeElement[] {
        const elements: CodeElement[] = [];
        const classStack: Array<{ name: string; indentation: number }> = [];

        lines.forEach((line, index) => {
            if (!line) {
                return;
            }

            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                return;
            }

            const indentation = this.getIndentationLevel(line);

            while (
                classStack.length > 0 &&
                indentation <= classStack[classStack.length - 1].indentation
            ) {
                classStack.pop();
            }

            // Phase 1: Check for TypeAlias (PEP 613)
            const typeAliasMatch = trimmed.match(/^\s*(\w+)\s*:\s*TypeAlias\s*=/);
            if (typeAliasMatch) {
                const lineEnd = this.estimateElementEnd(lines, index, "type_definition");
                const codeSnippet = lines.slice(index, lineEnd + 1).join('\n');
                elements.push({
                    name: typeAliasMatch[1],
                    type: "type_definition",
                    lineStart: index + 1,
                    lineEnd: lineEnd + 1,
                    filePath,
                    signature: trimmed,
                    codeSnippet,
                });
                return;
            }

            // Phase 1: Check for decorators
            const decoratorMatch = trimmed.match(/^\s*@(\w+)/);
            if (decoratorMatch) {
                const lineEnd = index; // Decorators are typically single line
                elements.push({
                    name: decoratorMatch[1],
                    type: "annotation",
                    lineStart: index + 1,
                    lineEnd: index + 1,
                    filePath,
                    signature: trimmed,
                    codeSnippet: trimmed,
                });
                return;
            }

            // Phase 1: Check for UPPER_CASE constants (module level only)
            if (classStack.length === 0) {
                const constantMatch = trimmed.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
                if (constantMatch) {
                    const lineEnd = index; // Constants are typically single line
                    elements.push({
                        name: constantMatch[1],
                        type: "constant",
                        lineStart: index + 1,
                        lineEnd: index + 1,
                        filePath,
                        signature: trimmed,
                        codeSnippet: trimmed,
                    });
                    return;
                }
            }

            // Check for class definition
            const classMatch = trimmed.match(/^\s*class\s+(\w+)/);
            if (classMatch) {
                const className = classMatch[1];
                const lineEnd = this.estimateElementEnd(lines, index, "class");
                const codeSnippet = lines.slice(index, lineEnd).join('\n');

                // Phase 1: Determine if it's an Enum class
                const isEnum = trimmed.includes('(Enum)') || trimmed.includes('(IntEnum)') || 
                              trimmed.includes('(Flag)') || trimmed.includes('(StrEnum)');
                const elementType = isEnum ? "enum" : "class";

                // Phase 2: Extract documentation
                let documentation = this.documentationExtractor.extractDocumentation(lines, index, 'python');
                const inlineComments = this.documentationExtractor.extractInlineComments(codeSnippet, 'python');
                
                // Add inline comments to documentation (create doc object if needed)
                if (inlineComments.length > 0) {
                    if (!documentation) {
                        documentation = {};
                    }
                    documentation.inlineComments = inlineComments;
                }

                elements.push({
                    name: className,
                    type: elementType,
                    lineStart: index + 1,
                    lineEnd: lineEnd + 1,
                    filePath,
                    signature: trimmed,
                    codeSnippet,
                    documentation: documentation && Object.keys(documentation).length > 0 ? documentation : undefined,
                });
                classStack.push({ name: className, indentation });
                return;
            }

            // Check for function/method definition
            const functionMatch = trimmed.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
            if (!functionMatch) {
                return;
            }

            const name = functionMatch[1];
            if (this.skippedKeywords.has(name)) {
                return;
            }

            const elementType = classStack.length > 0 ? "method" : "function";
            const lineEnd = this.estimateElementEnd(lines, index, elementType);
            const codeSnippet = lines.slice(index, lineEnd).join('\n');

            // Phase 2: Extract documentation
            let documentation = this.documentationExtractor.extractDocumentation(lines, index, 'python');
            const inlineComments = this.documentationExtractor.extractInlineComments(codeSnippet, 'python');
            
            // Add inline comments to documentation (create doc object if needed)
            if (inlineComments.length > 0) {
                if (!documentation) {
                    documentation = {};
                }
                documentation.inlineComments = inlineComments;
            }

            elements.push({
                name,
                type: elementType,
                lineStart: index + 1,
                lineEnd: lineEnd + 1,
                filePath,
                signature: trimmed,
                codeSnippet,
                documentation: documentation && Object.keys(documentation).length > 0 ? documentation : undefined,
            });
        });

        return elements;
    }

    private getIndentationLevel(line: string): number {
        const match = line.match(/^\s*/);
        return match ? match[0].length : 0;
    }

    /**
     * Estimate the end line of a code element for regex-based parsing
     */
    private estimateElementEnd(lines: string[], startIndex: number, elementType: string): number {
        const startLine = lines[startIndex];
        const startIndentation = this.getIndentationLevel(startLine);
        
        // For Python, use indentation-based detection
        if (elementType === "class" || elementType === "function" || elementType === "method" || elementType === "enum") {
            let lastNonEmptyLine = startIndex;
            
            for (let i = startIndex + 1; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim()) {
                    continue; // Skip empty lines
                }
                
                const currentIndentation = this.getIndentationLevel(line);
                if (currentIndentation <= startIndentation) {
                    // Found a line with less/equal indentation - function ends at last non-empty line
                    return lastNonEmptyLine;
                }
                
                lastNonEmptyLine = i;
            }
            
            // Reached end of file
            return lastNonEmptyLine;
        }
        
        // For other languages, look for closing braces or similar patterns
        let braceCount = 0;
        let inString = false;
        let stringChar = '';
        
        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i];
            
            for (let j = 0; j < line.length; j++) {
                const char = line[j];
                
                if (!inString) {
                    if (char === '"' || char === "'" || char === '`') {
                        inString = true;
                        stringChar = char;
                    } else if (char === '{') {
                        braceCount++;
                    } else if (char === '}') {
                        braceCount--;
                        if (braceCount === 0 && i > startIndex) {
                            return i;
                        }
                    }
                } else if (char === stringChar && line[j - 1] !== '\\') {
                    inString = false;
                }
            }
            
            // If we're at the start line and no braces were found, assume single line
            if (i === startIndex && braceCount === 0 && !line.includes('{')) {
                return i;
            }
        }
        
        return lines.length - 1;
    }

    private async enrichCodeElements(
        elements: CodeElement[],
        filePath: string,
        language: string
    ): Promise<CodeElement[]> {
        // For now, return the elements as-is, but this method can be enhanced
        // to use ts-morph or other advanced parsing techniques in the future
        return elements;
    }

    /**
     * Phase 3: Build relationships for all elements in a file
     */
    public buildFileRelationships(
        elements: CodeElement[],
        language: string
    ): import('../../common/models/context-models').CodeRelationships {
        const relationships: import('../../common/models/context-models').CodeRelationships = {
            calls: [],
            extends: [],
            implements: [],
            typeDependencies: [],
        };

        for (const element of elements) {
            // Build call graph
            if (element.codeSnippet && (element.type === 'function' || element.type === 'method' || element.type === 'arrow_function')) {
                const calls = this.relationshipTracker.buildCallGraph(
                    element.codeSnippet,
                    element.name,
                    language
                );
                relationships.calls.push(...calls);
            }

            // Track inheritance
            if (element.type === 'class' && element.signature) {
                const inheritance = this.relationshipTracker.trackInheritance(
                    element.signature,
                    element.name,
                    language
                );
                
                if (inheritance.extends) {
                    relationships.extends.push({
                        child: element.name,
                        parent: inheritance.extends,
                    });
                }
                
                for (const iface of inheritance.implements) {
                    relationships.implements.push({
                        class: element.name,
                        interface: iface,
                    });
                }
            }

            // Track type dependencies
            if (element.signature && element.codeSnippet) {
                const typeDeps = this.relationshipTracker.trackTypeDependencies(
                    element.signature,
                    element.codeSnippet,
                    element.name,
                    language
                );
                
                if (typeDeps.length > 0) {
                    relationships.typeDependencies.push({
                        type: element.name,
                        dependsOn: typeDeps,
                    });
                }
            }
        }

        return relationships;
    }

    /**
     * Extract code elements using regex patterns (fallback method)
     */
    private async extractElementsWithRegex(
        filePath: string,
        language: string
    ): Promise<CodeElement[]> {
        const lines = await this.readFileLines(filePath);
        if (!lines) {
            return [];
        }

        if (language === "python") {
            return this.extractPythonElements(lines, filePath);
        }

        const patterns = this.elementPatterns.get(language);
        if (!patterns) {
            return [];
        }

        return this.extractUsingPatterns(lines, filePath, patterns);
    }

    /**
     * Read file content as a single string
     */
    private async readFileContent(filePath: string): Promise<string | null> {
        try {
            // Try VS Code API first (preferred in extension runtime)
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
            const content = textDecoder.decode(data);
            
            // Fallback to Node fs if VS Code API returns empty/invalid result (e.g., in tests)
            if (!content || content.trim() === '') {
                console.log(`[CodeParserService] VS Code API returned empty content, falling back to Node fs for: ${filePath}`);
                return await fsPromises.readFile(filePath, 'utf-8');
            }
            
            return content;
        } catch (error) {
            // If VS Code API fails, try Node fs as fallback
            try {
                return await fsPromises.readFile(filePath, 'utf-8');
            } catch (fsError) {
                console.warn(`Error reading file ${filePath}:`, error);
                return null;
            }
        }
    }

    /**
     * Extract import statements from file content (Phase 4 Enhanced)
     * Returns array of import paths (relative or absolute within project)
     * Now supports: type-only imports, re-exports, multiple languages
     */
    public extractImportsFromContent(fileContent: string, language: string): string[] {
        const imports: string[] = [];
        
        switch(language.toLowerCase()) {
            case 'typescript':
            case 'tsx':
                // Phase 4: Type-only imports: import type { X } from 'path'
                const typeImports = fileContent.matchAll(/import\s+type\s+(?:[\w{},\s*]+)\s+from\s+['"]([^'"]+)['"]/g);
                for (const match of typeImports) {
                    imports.push(match[1]);
                }
                // Fall through to also get regular imports
            case 'javascript':
            case 'jsx':
                // Static imports: import X from 'path'
                const staticImports = fileContent.matchAll(/import\s+(?:[\w{},\s*]+)\s+from\s+['"]([^'"]+)['"]/g);
                for (const match of staticImports) {
                    imports.push(match[1]);
                }
                // Dynamic imports: import('path')
                const dynamicImports = fileContent.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
                for (const match of dynamicImports) {
                    imports.push(match[1]);
                }
                // Require statements: require('path')
                const requires = fileContent.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
                for (const match of requires) {
                    imports.push(match[1]);
                }
                // Phase 4: Re-exports: export { X } from 'path' or export * from 'path'
                const reExports = fileContent.matchAll(/export\s+(?:\*|{[^}]+})\s+from\s+['"]([^'"]+)['"]/g);
                for (const match of reExports) {
                    imports.push(match[1]);
                }
                break;
                
            case 'python':
                // import module or from module import X (handle leading whitespace)
                const pyImports = fileContent.matchAll(/^\s*(?:import|from)\s+([\w.]+)/gm);
                for (const match of pyImports) {
                    imports.push(match[1]);
                }
                // Phase 4: Re-exports in __init__.py: from .module import *
                const pyReExports = fileContent.matchAll(/^\s*from\s+([\w.]+)\s+import\s+\*/gm);
                for (const match of pyReExports) {
                    imports.push(match[1]);
                }
                break;
            
            case 'java':
                // import package.ClassName;
                const javaImports = fileContent.matchAll(/import\s+([\w.]+);/g);
                for (const match of javaImports) {
                    imports.push(match[1]);
                }
                break;
            
            case 'cpp':
            case 'c':
                // #include "header.h" or #include <header.h>
                const cppIncludes = fileContent.matchAll(/#include\s+["<]([^">]+)[">]/g);
                for (const match of cppIncludes) {
                    imports.push(match[1]);
                }
                break;
            
            case 'go':
                // import "package/path" or import ( "pkg1" "pkg2" )
                const goImports = fileContent.matchAll(/import\s+(?:\([\s\S]*?\)|"([^"]+)")/g);
                for (const match of goImports) {
                    if (match[1]) {
                        imports.push(match[1]);
                    }
                }
                // Handle multi-line imports
                const goMultiImports = fileContent.matchAll(/"([^"]+)"/g);
                const inImportBlock = fileContent.includes('import (');
                if (inImportBlock) {
                    for (const match of goMultiImports) {
                        if (match[1] && !imports.includes(match[1])) {
                            imports.push(match[1]);
                        }
                    }
                }
                break;
            
            case 'rust':
                // use crate::module::Item; or pub use ...
                const rustUses = fileContent.matchAll(/(?:pub\s+)?use\s+([\w:]+)/g);
                for (const match of rustUses) {
                    imports.push(match[1]);
                }
                break;
            
            case 'csharp':
                // using System.Collections;
                const csharpUsings = fileContent.matchAll(/using\s+([\w.]+);/g);
                for (const match of csharpUsings) {
                    imports.push(match[1]);
                }
                break;
            
            case 'php':
                // use Vendor\Package\Class;
                const phpUses = fileContent.matchAll(/use\s+([\w\\]+)/g);
                for (const match of phpUses) {
                    imports.push(match[1]);
                }
                // require/include statements
                const phpRequires = fileContent.matchAll(/(?:require|include)(?:_once)?\s*\(?['"]([^'"]+)['"]\)?/g);
                for (const match of phpRequires) {
                    imports.push(match[1]);
                }
                break;
            
            case 'ruby':
                // require 'module' or require_relative 'path'
                const rubyRequires = fileContent.matchAll(/require(?:_relative)?\s+['"]([^'"]+)['"]/g);
                for (const match of rubyRequires) {
                    imports.push(match[1]);
                }
                break;
        }
        
        return imports;
    }
}
