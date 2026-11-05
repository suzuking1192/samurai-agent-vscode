import * as path from 'path';
import * as fs from 'fs';
import { SamuraiAgentPanelWebviewViewProvider } from '../webview/SamuraiAgentPanelWebviewViewProvider';

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')
);
const contributes = packageJson.contributes;

describe('package.json manifest', () => {
  it('should use "viewsContainers" (plural), not "viewContainers"', () => {
    expect(contributes.viewsContainers).toBeDefined();
    expect(contributes.viewContainers).toBeUndefined();
  });

  it('should define all view container IDs referenced in "views"', () => {
    const containerIds = (contributes.viewsContainers.activitybar || []).map(
      (c: any) => c.id
    );
    const viewGroupIds = Object.keys(contributes.views);

    for (const groupId of viewGroupIds) {
      // Built-in containers (explorer, scm, debug, etc.) don't need to be declared
      if (['explorer', 'scm', 'debug', 'test'].includes(groupId)) {
        continue;
      }
      expect(containerIds).toContain(groupId);
    }
  });

  it('should have agentPanel view ID matching SamuraiAgentPanelWebviewViewProvider.viewType', () => {
    const allViews = Object.values(contributes.views)
      .flat()
      .map((v: any) => v.id);
    expect(allViews).toContain(SamuraiAgentPanelWebviewViewProvider.viewType);
  });

  it('should have activity bar icon file that exists on disk', () => {
    const iconPath = contributes.viewsContainers.activitybar[0].icon;
    const fullPath = path.resolve(__dirname, '../../', iconPath);
    expect(fs.existsSync(fullPath)).toBe(true);
  });

  it('should use SVG format for activity bar icon', () => {
    const iconPath = contributes.viewsContainers.activitybar[0].icon;
    expect(iconPath).toMatch(/\.svg$/);
  });

  it('should have view name matching container title when container has a single view', () => {
    for (const container of contributes.viewsContainers.activitybar) {
      const views = contributes.views[container.id] || [];
      if (views.length === 1) {
        expect(views[0].name).toBe(container.title);
      }
    }
  });
});
