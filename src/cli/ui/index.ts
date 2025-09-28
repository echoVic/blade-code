/**
 * UI模块主入口
 * 提供统一的UI组件接口
 */

import { UIAnimation } from "./components/Animation.js";
import { UIDisplay } from "./components/Display.js";
import { UIInput } from "./components/Input.js";
import { UILayout } from "./components/Layout.js";
import { UIList } from "./components/List.js";
import { UIProgress } from "./components/Progress.js";
import {
  ThemeManager,
  themeManager,
  UIColors,
  UIStyles,
} from "./themes/index.js";
import { UIFormatter, UIValidator } from "./utils/index.js";

// 导出各个组件
export {
  ThemeManager,
  themeManager,
  UIAnimation,
  UIColors,
  UIDisplay,
  UIFormatter,
  UIInput,
  UILayout,
  UIList,
  UIProgress,
  UIStyles,
  UIValidator,
};

// 便捷导出
export const UI = {
  Animation: UIAnimation,
  Display: UIDisplay,
  Input: UIInput,
  Progress: UIProgress,
  List: UIList,
  Layout: UILayout,
  Theme: themeManager,
};
