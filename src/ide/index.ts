/**
 * IDE 集成模块
 */

export type { IdeInfo } from './detectIde.js';
export { IdeDetector } from './detectIde.js';
export { IdeClient } from './ideClient.js';
export type { IdeInfo as IdeContextInfo, ProjectInfo } from './ideContext.js';
export { IdeContext } from './ideContext.js';
export type { InstalledIde } from './ideInstaller.js';
export { IdeInstaller } from './ideInstaller.js';
