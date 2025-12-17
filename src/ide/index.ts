/**
 * IDE 集成模块
 */

export { IdeDetector } from './detectIde.js';
export type { IdeInfo } from './detectIde.js';

export { IdeInstaller } from './ideInstaller.js';
export type { InstalledIde } from './ideInstaller.js';

export { IdeClient } from './ideClient.js';
export { IdeContext } from './ideContext.js';
export type { IdeInfo as IdeContextInfo, ProjectInfo } from './ideContext.js';
