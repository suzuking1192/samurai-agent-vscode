import path from "path";

export interface FrameworkDefinition {
  id: FrameworkId;
  displayName: string;
  packages: string[];
  promptFile: string;
}

export type FrameworkId =
  | "typescript"
  | "react"
  | "nextjs"
  | "node-express"
  | "zustand"
  | "redux-toolkit"
  | "vite"
  | "webpack";

export const FRAMEWORK_DEFINITIONS: readonly FrameworkDefinition[] = [
  {
    id: "typescript",
    displayName: "TypeScript",
    packages: ["typescript"],
    promptFile: path.join("frameworks", "typescript.md"),
  },
  {
    id: "react",
    displayName: "React",
    packages: ["react", "react-dom"],
    promptFile: path.join("frameworks", "react.md"),
  },
  {
    id: "nextjs",
    displayName: "Next.js",
    packages: ["next"],
    promptFile: path.join("frameworks", "nextjs.md"),
  },
  {
    id: "node-express",
    displayName: "Node.js (Express)",
    packages: ["express"],
    promptFile: path.join("frameworks", "node-express.md"),
  },
  {
    id: "zustand",
    displayName: "Zustand",
    packages: ["zustand"],
    promptFile: path.join("frameworks", "zustand.md"),
  },
  {
    id: "redux-toolkit",
    displayName: "Redux Toolkit",
    packages: ["@reduxjs/toolkit", "redux", "react-redux"],
    promptFile: path.join("frameworks", "redux-toolkit.md"),
  },
  {
    id: "vite",
    displayName: "Vite",
    packages: ["vite"],
    promptFile: path.join("frameworks", "vite.md"),
  },
  {
    id: "webpack",
    displayName: "Webpack",
    packages: ["webpack", "webpack-cli"],
    promptFile: path.join("frameworks", "webpack.md"),
  },
] as const;

const frameworkMap: Record<FrameworkId, FrameworkDefinition> = FRAMEWORK_DEFINITIONS.reduce(
  (acc, definition) => {
    acc[definition.id] = definition;
    return acc;
  },
  {} as Record<FrameworkId, FrameworkDefinition>,
);

export function getFrameworkDefinition(id: FrameworkId): FrameworkDefinition {
  return frameworkMap[id];
}

export function isFrameworkId(value: string): value is FrameworkId {
  return Object.prototype.hasOwnProperty.call(frameworkMap, value);
}

