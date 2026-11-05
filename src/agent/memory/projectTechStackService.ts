import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { DataStore } from "../../persistence/dataStore";
import { ResponseType } from "../../common/models/response-models";
import { ProjectSettings } from "../../common/models/settings-models";
import { FRAMEWORK_DEFINITIONS, FrameworkDefinition, FrameworkId, isFrameworkId } from "./techStackDefinitions";

export interface TechStackMetadata {
  frameworks: FrameworkId[];
  packageJsonHash: string;
  detectedPackages: string[];
  detectedAt: string;
}

interface PackageJsonInfo {
  hash: string;
  packages: Set<string>;
}

export class ProjectTechStackService {
  constructor(private readonly dataStore: DataStore) {}

  public async ensureTechStack(workspaceRoot: string): Promise<TechStackMetadata | undefined> {
    const settings = this.loadProjectSettings();
    if (!settings) {
      return undefined;
    }

    const stored = this.extractTechStack(settings);
    if (!workspaceRoot) {
      return stored;
    }

    const packageInfo = await this.loadPackageJsonInfo(workspaceRoot);
    if (!packageInfo) {
      return stored;
    }

    if (stored && stored.packageJsonHash === packageInfo.hash) {
      return stored;
    }

    const nextMetadata = this.buildTechStackMetadata(packageInfo);
    if (this.hasMeaningfulChanges(stored, nextMetadata)) {
      this.persistTechStack(settings, nextMetadata);
    }

    return nextMetadata;
  }

  public getStoredTechStack(): TechStackMetadata | undefined {
    const settings = this.loadProjectSettings();
    return settings ? this.extractTechStack(settings) : undefined;
  }

  private loadProjectSettings(): ProjectSettings | undefined {
    const response = this.dataStore.readProjectSettings();
    if (response.type !== ResponseType.SUCCESS || !response.payload) {
      console.warn(
        "[ProjectTechStackService] Failed to load project settings:",
        response.error,
      );
      return undefined;
    }
    return response.payload;
  }

  private extractTechStack(settings: ProjectSettings): TechStackMetadata | undefined {
    const raw = settings.metadata?.techStack;
    if (!raw) {
      return undefined;
    }

    try {
      const rawFrameworkCandidates = Array.isArray(raw.frameworks)
        ? (raw.frameworks as readonly unknown[])
        : [];

      const frameworks = rawFrameworkCandidates
        .filter(
          (candidate): candidate is FrameworkId =>
            typeof candidate === "string" && isFrameworkId(candidate),
        )
        .sort();

      return {
        frameworks,
        packageJsonHash:
          typeof raw.packageJsonHash === "string" && raw.packageJsonHash ? raw.packageJsonHash : "",
        detectedPackages: Array.isArray(raw.detectedPackages)
          ? Array.from(
              new Set(
                (raw.detectedPackages as readonly unknown[]).filter(
                  (pkg): pkg is string => typeof pkg === "string",
                ),
              ),
            ).sort()
          : [],
        detectedAt: typeof raw.detectedAt === "string" ? raw.detectedAt : new Date().toISOString(),
      };
    } catch (error) {
      console.warn("[ProjectTechStackService] Failed to extract stored tech stack:", error);
      return undefined;
    }
  }

  private async loadPackageJsonInfo(workspaceRoot: string): Promise<PackageJsonInfo | undefined> {
    try {
      const packageJsonPath = path.join(workspaceRoot, "package.json");
      const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
      const hash = this.computeHash(packageJsonContent);
      const packages = this.collectPackageNames(packageJsonContent);
      return { hash, packages };
    } catch (error) {
      console.warn(
        "[ProjectTechStackService] Unable to load package.json for tech stack detection:",
        error,
      );
      return undefined;
    }
  }

  private computeHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private collectPackageNames(packageJsonContent: string): Set<string> {
    try {
      const parsed = JSON.parse(packageJsonContent);
      const packageNames = new Set<string>();
      const sections = [
        parsed.dependencies,
        parsed.devDependencies,
        parsed.peerDependencies,
        parsed.optionalDependencies,
      ];

      for (const section of sections) {
        if (!section || typeof section !== "object") {
          continue;
        }
        for (const packageName of Object.keys(section)) {
          packageNames.add(packageName.toLowerCase());
        }
      }

      return packageNames;
    } catch (error) {
      console.warn("[ProjectTechStackService] Failed to parse package.json:", error);
      return new Set<string>();
    }
  }

  private buildTechStackMetadata(packageInfo: PackageJsonInfo): TechStackMetadata {
    const frameworks = this.detectFrameworks(packageInfo.packages);
    const detectedPackages = Array.from(packageInfo.packages).sort();

    return {
      frameworks,
      packageJsonHash: packageInfo.hash,
      detectedPackages,
      detectedAt: new Date().toISOString(),
    };
  }

  private detectFrameworks(packageNames: Set<string>): FrameworkId[] {
    const detected = new Set<FrameworkId>();

    for (const definition of FRAMEWORK_DEFINITIONS) {
      if (this.matchesFramework(definition, packageNames)) {
        detected.add(definition.id);
      }
    }

    return Array.from(detected).sort();
  }

  private matchesFramework(definition: FrameworkDefinition, packageNames: Set<string>): boolean {
    return definition.packages.some((pkg) => packageNames.has(pkg.toLowerCase()));
  }

  private hasMeaningfulChanges(
    current: TechStackMetadata | undefined,
    next: TechStackMetadata,
  ): boolean {
    if (!current) {
      return true;
    }

    if (current.packageJsonHash !== next.packageJsonHash) {
      return true;
    }

    return !this.areFrameworksEqual(current.frameworks, next.frameworks);
  }

  private areFrameworksEqual(left: FrameworkId[], right: FrameworkId[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => value === right[index]);
  }

  private persistTechStack(settings: ProjectSettings, metadata: TechStackMetadata): void {
    const updatedSettings: ProjectSettings = {
      ...settings,
      metadata: {
        ...(settings.metadata ?? {}),
        techStack: metadata,
      },
    };

    const response = this.dataStore.saveProjectSettings(updatedSettings);
    if (response.type !== ResponseType.SUCCESS) {
      throw new Error(
        response.error || "[ProjectTechStackService] Failed to persist tech stack metadata",
      );
    }
  }
}

