import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DataStore } from "../../../persistence/dataStore";
import { ProjectTechStackService } from "../projectTechStackService";

jest.mock("vscode", () => ({}));

describe("ProjectTechStackService", () => {
  let tempDir: string;
  let dataStore: DataStore;
  let service: ProjectTechStackService;
  let packageJsonPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "samurai-tech-stack-"));
    packageJsonPath = path.join(tempDir, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify(
        {
          name: "sample-app",
          version: "0.0.1",
          dependencies: {
            react: "18.2.0",
            "react-dom": "18.2.0",
          },
          devDependencies: {
            typescript: "5.3.0",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    dataStore = new DataStore(tempDir);
    service = new ProjectTechStackService(dataStore);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("detects frameworks and caches the result", async () => {
    const saveSpy = jest.spyOn(dataStore, "saveProjectSettings");

    const firstDetection = await service.ensureTechStack(tempDir);

    expect(firstDetection?.frameworks).toEqual(["react", "typescript"]);
    expect(firstDetection?.detectedPackages).toEqual(
      expect.arrayContaining(["react", "react-dom", "typescript"]),
    );
    expect(saveSpy).toHaveBeenCalledTimes(1);

    saveSpy.mockClear();
    const secondDetection = await service.ensureTechStack(tempDir);
    expect(secondDetection).toEqual(firstDetection);
    expect(saveSpy).not.toHaveBeenCalled();

    const settingsResponse = dataStore.readProjectSettings();
    const metadata = settingsResponse.payload?.metadata?.techStack;
    expect(metadata?.frameworks).toEqual(["react", "typescript"]);
    expect(metadata?.packageJsonHash).toBe(firstDetection?.packageJsonHash);
  });

  it("refreshes metadata when package.json changes", async () => {
    const initial = await service.ensureTechStack(tempDir);
    const initialHash = initial?.packageJsonHash;

    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify(
        {
          name: "sample-app",
          version: "0.0.2",
          dependencies: {
            next: "14.0.0",
            react: "18.2.0",
            "react-dom": "18.2.0",
            express: "4.18.0",
          },
          devDependencies: {
            typescript: "5.3.0",
            vite: "5.0.0",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const saveSpy = jest.spyOn(dataStore, "saveProjectSettings");
    const refreshed = await service.ensureTechStack(tempDir);

    expect(refreshed?.frameworks).toEqual(["nextjs", "node-express", "react", "typescript", "vite"]);
    expect(refreshed?.packageJsonHash).not.toBe(initialHash);
    expect(saveSpy).toHaveBeenCalled();
  });
});

