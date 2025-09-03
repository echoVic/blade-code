#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.__filename = require('url').fileURLToPath(import.meta.url);
globalThis.__dirname = require('path').dirname(globalThis.__filename);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/cli/src/ui/themes/colors.ts
var UIColors;
var init_colors = __esm({
  "packages/cli/src/ui/themes/colors.ts"() {
    "use strict";
    UIColors = {
      // 主要颜色
      primary: "#0066cc",
      secondary: "#6c757d",
      // 状态颜色
      success: "#28a745",
      warning: "#ffc107",
      error: "#dc3545",
      info: "#17a2b8",
      // 灰度颜色
      light: "#f8f9fa",
      dark: "#343a40",
      muted: "#6c757d",
      // 文本颜色
      text: {
        primary: "#212529",
        secondary: "#6c757d",
        muted: "#6c757d",
        light: "#ffffff"
      },
      // 背景颜色
      background: {
        primary: "#ffffff",
        secondary: "#f8f9fa",
        dark: "#343a40"
      },
      // 边框颜色
      border: {
        light: "#dee2e6",
        dark: "#495057"
      },
      // 特殊用途颜色
      accent: "#e83e8c",
      highlight: "#fff3cd"
    };
  }
});

// packages/cli/src/ui/themes/theme.ts
function validateTheme(theme) {
  if (!theme || typeof theme !== "object") {
    return false;
  }
  if (!theme.name || typeof theme.name !== "string") {
    return false;
  }
  if (!theme.colors || typeof theme.colors !== "object") {
    return false;
  }
  const requiredColorKeys = [
    "primary",
    "secondary",
    "accent",
    "success",
    "warning",
    "error",
    "info",
    "light",
    "dark",
    "muted",
    "highlight"
  ];
  for (const key of requiredColorKeys) {
    if (!theme.colors[key] || typeof theme.colors[key] !== "string") {
      return false;
    }
  }
  if (!theme.colors.text || typeof theme.colors.text !== "object") {
    return false;
  }
  if (!theme.colors.background || typeof theme.colors.background !== "object") {
    return false;
  }
  if (!theme.colors.border || typeof theme.colors.border !== "object") {
    return false;
  }
  const requiredTextKeys = ["primary", "secondary", "muted", "light"];
  const requiredBgKeys = ["primary", "secondary", "dark"];
  const requiredBorderKeys = ["light", "dark"];
  for (const key of requiredTextKeys) {
    if (!theme.colors.text[key] || typeof theme.colors.text[key] !== "string") {
      return false;
    }
  }
  for (const key of requiredBgKeys) {
    if (!theme.colors.background[key] || typeof theme.colors.background[key] !== "string") {
      return false;
    }
  }
  for (const key of requiredBorderKeys) {
    if (!theme.colors.border[key] || typeof theme.colors.border[key] !== "string") {
      return false;
    }
  }
  if (!theme.spacing || typeof theme.spacing !== "object") {
    return false;
  }
  if (!theme.typography || typeof theme.typography !== "object") {
    return false;
  }
  if (!theme.borderRadius || typeof theme.borderRadius !== "object") {
    return false;
  }
  if (!theme.boxShadow || typeof theme.boxShadow !== "object") {
    return false;
  }
  return true;
}
var init_theme = __esm({
  "packages/cli/src/ui/themes/theme.ts"() {
    "use strict";
  }
});

// packages/cli/src/ui/themes/themes-presets.ts
var ayuDark, dracula, monokai, nord, solarizedLight, solarizedDark, tokyoNight, github, gruvbox, oneDark, catppuccin, rosePine, kanagawa, themes;
var init_themes_presets = __esm({
  "packages/cli/src/ui/themes/themes-presets.ts"() {
    "use strict";
    ayuDark = {
      name: "ayu-dark",
      colors: {
        primary: "#ffcc66",
        secondary: "#bae67e",
        accent: "#73d0ff",
        success: "#bae67e",
        warning: "#ffcc66",
        error: "#ff3333",
        info: "#73d0ff",
        light: "#f0f0f0",
        dark: "#000000",
        muted: "#5c6773",
        highlight: "#2d323b",
        text: {
          primary: "#e6e1cf",
          secondary: "#bae67e",
          muted: "#5c6773",
          light: "#ffffff"
        },
        background: {
          primary: "#0f1419",
          secondary: "#14191f",
          dark: "#000000"
        },
        border: {
          light: "#2d323b",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(0, 0, 0, 0.2)",
        base: "0 1px 3px 0 rgba(0, 0, 0, 0.3), 0 1px 2px 0 rgba(0, 0, 0, 0.2)",
        lg: "0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.2)"
      }
    };
    dracula = {
      name: "dracula",
      colors: {
        primary: "#bd93f9",
        secondary: "#ffb86c",
        accent: "#ff79c6",
        success: "#50fa7b",
        warning: "#f1fa8c",
        error: "#ff5555",
        info: "#8be9fd",
        light: "#f8f8f2",
        dark: "#282a36",
        muted: "#6272a4",
        highlight: "#44475a",
        text: {
          primary: "#f8f8f2",
          secondary: "#f1fa8c",
          muted: "#6272a4",
          light: "#ffffff"
        },
        background: {
          primary: "#282a36",
          secondary: "#44475a",
          dark: "#21222c"
        },
        border: {
          light: "#44475a",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(40, 42, 54, 0.2)",
        base: "0 1px 3px 0 rgba(40, 42, 54, 0.3), 0 1px 2px 0 rgba(40, 42, 54, 0.2)",
        lg: "0 10px 15px -3px rgba(40, 42, 54, 0.3), 0 4px 6px -2px rgba(40, 42, 54, 0.2)"
      }
    };
    monokai = {
      name: "monokai",
      colors: {
        primary: "#66d9ef",
        secondary: "#a6e22e",
        accent: "#f92672",
        success: "#a6e22e",
        warning: "#e6db74",
        error: "#f92672",
        info: "#66d9ef",
        light: "#f8f8f2",
        dark: "#272822",
        muted: "#75715e",
        highlight: "#3e3d32",
        text: {
          primary: "#f8f8f2",
          secondary: "#e6db74",
          muted: "#75715e",
          light: "#ffffff"
        },
        background: {
          primary: "#272822",
          secondary: "#3e3d32",
          dark: "#1e1f1c"
        },
        border: {
          light: "#3e3d32",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(39, 40, 34, 0.2)",
        base: "0 1px 3px 0 rgba(39, 40, 34, 0.3), 0 1px 2px 0 rgba(39, 40, 34, 0.2)",
        lg: "0 10px 15px -3px rgba(39, 40, 34, 0.3), 0 4px 6px -2px rgba(39, 40, 34, 0.2)"
      }
    };
    nord = {
      name: "nord",
      colors: {
        primary: "#88c0d0",
        secondary: "#81a1c1",
        accent: "#b48ead",
        success: "#a3be8c",
        warning: "#ebcb8b",
        error: "#bf616a",
        info: "#88c0d0",
        light: "#eceff4",
        dark: "#2e3440",
        muted: "#4c566a",
        highlight: "#434c5e",
        text: {
          primary: "#eceff4",
          secondary: "#d8dee9",
          muted: "#4c566a",
          light: "#ffffff"
        },
        background: {
          primary: "#2e3440",
          secondary: "#3b4252",
          dark: "#242933"
        },
        border: {
          light: "#434c5e",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(46, 52, 64, 0.2)",
        base: "0 1px 3px 0 rgba(46, 52, 64, 0.3), 0 1px 2px 0 rgba(46, 52, 64, 0.2)",
        lg: "0 10px 15px -3px rgba(46, 52, 64, 0.3), 0 4px 6px -2px rgba(46, 52, 64, 0.2)"
      }
    };
    solarizedLight = {
      name: "solarized-light",
      colors: {
        primary: "#268bd2",
        secondary: "#2aa198",
        accent: "#d33682",
        success: "#859900",
        warning: "#b58900",
        error: "#dc322f",
        info: "#268bd2",
        light: "#fdf6e3",
        dark: "#073642",
        muted: "#93a1a1",
        highlight: "#eee8d5",
        text: {
          primary: "#586e75",
          secondary: "#657b83",
          muted: "#93a1a1",
          light: "#002b36"
        },
        background: {
          primary: "#fdf6e3",
          secondary: "#eee8d5",
          dark: "#073642"
        },
        border: {
          light: "#eee8d5",
          dark: "#073642"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(253, 246, 227, 0.2)",
        base: "0 1px 3px 0 rgba(253, 246, 227, 0.3), 0 1px 2px 0 rgba(253, 246, 227, 0.2)",
        lg: "0 10px 15px -3px rgba(253, 246, 227, 0.3), 0 4px 6px -2px rgba(253, 246, 227, 0.2)"
      }
    };
    solarizedDark = {
      name: "solarized-dark",
      colors: {
        primary: "#268bd2",
        secondary: "#2aa198",
        accent: "#d33682",
        success: "#859900",
        warning: "#b58900",
        error: "#dc322f",
        info: "#268bd2",
        light: "#fdf6e3",
        dark: "#073642",
        muted: "#586e75",
        highlight: "#073642",
        text: {
          primary: "#839496",
          secondary: "#93a1a1",
          muted: "#586e75",
          light: "#fdf6e3"
        },
        background: {
          primary: "#002b36",
          secondary: "#073642",
          dark: "#001f29"
        },
        border: {
          light: "#073642",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(0, 43, 54, 0.2)",
        base: "0 1px 3px 0 rgba(0, 43, 54, 0.3), 0 1px 2px 0 rgba(0, 43, 54, 0.2)",
        lg: "0 10px 15px -3px rgba(0, 43, 54, 0.3), 0 4px 6px -2px rgba(0, 43, 54, 0.2)"
      }
    };
    tokyoNight = {
      name: "tokyo-night",
      colors: {
        primary: "#7aa2f7",
        secondary: "#7dcfff",
        accent: "#bb9af7",
        success: "#9ece6a",
        warning: "#e0af68",
        error: "#f7768e",
        info: "#7aa2f7",
        light: "#c0caf5",
        dark: "#1a1b26",
        muted: "#565f89",
        highlight: "#292e42",
        text: {
          primary: "#a9b1d6",
          secondary: "#c0caf5",
          muted: "#565f89",
          light: "#ffffff"
        },
        background: {
          primary: "#1a1b26",
          secondary: "#292e42",
          dark: "#16161e"
        },
        border: {
          light: "#292e42",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(26, 27, 38, 0.2)",
        base: "0 1px 3px 0 rgba(26, 27, 38, 0.3), 0 1px 2px 0 rgba(26, 27, 38, 0.2)",
        lg: "0 10px 15px -3px rgba(26, 27, 38, 0.3), 0 4px 6px -2px rgba(26, 27, 38, 0.2)"
      }
    };
    github = {
      name: "github",
      colors: {
        primary: "#0969da",
        secondary: "#8250df",
        accent: "#bc4c00",
        success: "#1a7f37",
        warning: "#9a6700",
        error: "#d1242f",
        info: "#0969da",
        light: "#f6f8fa",
        dark: "#24292f",
        muted: "#6e7781",
        highlight: "#ddf4ff",
        text: {
          primary: "#24292f",
          secondary: "#57606a",
          muted: "#6e7781",
          light: "#ffffff"
        },
        background: {
          primary: "#ffffff",
          secondary: "#f6f8fa",
          dark: "#24292f"
        },
        border: {
          light: "#d0d7de",
          dark: "#24292f"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(255, 255, 255, 0.2)",
        base: "0 1px 3px 0 rgba(255, 255, 255, 0.3), 0 1px 2px 0 rgba(255, 255, 255, 0.2)",
        lg: "0 10px 15px -3px rgba(255, 255, 255, 0.3), 0 4px 6px -2px rgba(255, 255, 255, 0.2)"
      }
    };
    gruvbox = {
      name: "gruvbox",
      colors: {
        primary: "#83a598",
        secondary: "#8ec07c",
        accent: "#d3869b",
        success: "#b8bb26",
        warning: "#fabd2f",
        error: "#fb4934",
        info: "#83a598",
        light: "#fbf1c7",
        dark: "#282828",
        muted: "#928374",
        highlight: "#3c3836",
        text: {
          primary: "#ebdbb2",
          secondary: "#d5c4a1",
          muted: "#928374",
          light: "#ffffff"
        },
        background: {
          primary: "#282828",
          secondary: "#3c3836",
          dark: "#1d2021"
        },
        border: {
          light: "#3c3836",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(40, 40, 40, 0.2)",
        base: "0 1px 3px 0 rgba(40, 40, 40, 0.3), 0 1px 2px 0 rgba(40, 40, 40, 0.2)",
        lg: "0 10px 15px -3px rgba(40, 40, 40, 0.3), 0 4px 6px -2px rgba(40, 40, 40, 0.2)"
      }
    };
    oneDark = {
      name: "one-dark",
      colors: {
        primary: "#61afef",
        secondary: "#c678dd",
        accent: "#e5c07b",
        success: "#98c379",
        warning: "#e5c07b",
        error: "#e06c75",
        info: "#56b6c2",
        light: "#abb2bf",
        dark: "#282c34",
        muted: "#5c6370",
        highlight: "#3e4451",
        text: {
          primary: "#abb2bf",
          secondary: "#c6c8d0",
          muted: "#5c6370",
          light: "#ffffff"
        },
        background: {
          primary: "#282c34",
          secondary: "#3e4451",
          dark: "#21252b"
        },
        border: {
          light: "#3e4451",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(40, 44, 52, 0.2)",
        base: "0 1px 3px 0 rgba(40, 44, 52, 0.3), 0 1px 2px 0 rgba(40, 44, 52, 0.2)",
        lg: "0 10px 15px -3px rgba(40, 44, 52, 0.3), 0 4px 6px -2px rgba(40, 44, 52, 0.2)"
      }
    };
    catppuccin = {
      name: "catppuccin",
      colors: {
        primary: "#89b4fa",
        secondary: "#cba6f7",
        accent: "#f5c2e7",
        success: "#a6e3a1",
        warning: "#f9e2af",
        error: "#f38ba8",
        info: "#89dceb",
        light: "#cdd6f4",
        dark: "#11111b",
        muted: "#6c7086",
        highlight: "#181825",
        text: {
          primary: "#cdd6f4",
          secondary: "#bac2de",
          muted: "#6c7086",
          light: "#ffffff"
        },
        background: {
          primary: "#1e1e2e",
          secondary: "#181825",
          dark: "#11111b"
        },
        border: {
          light: "#181825",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(30, 30, 46, 0.2)",
        base: "0 1px 3px 0 rgba(30, 30, 46, 0.3), 0 1px 2px 0 rgba(30, 30, 46, 0.2)",
        lg: "0 10px 15px -3px rgba(30, 30, 46, 0.3), 0 4px 6px -2px rgba(30, 30, 46, 0.2)"
      }
    };
    rosePine = {
      name: "rose-pine",
      colors: {
        primary: "#9ccfd8",
        secondary: "#c4a7e7",
        accent: "#f6c177",
        success: "#31748f",
        warning: "#f6c177",
        error: "#eb6f92",
        info: "#9ccfd8",
        light: "#e0def4",
        dark: "#191724",
        muted: "#6e6a86",
        highlight: "#1f1d2e",
        text: {
          primary: "#e0def4",
          secondary: "#cecacd",
          muted: "#6e6a86",
          light: "#ffffff"
        },
        background: {
          primary: "#191724",
          secondary: "#1f1d2e",
          dark: "#12101a"
        },
        border: {
          light: "#1f1d2e",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(25, 23, 36, 0.2)",
        base: "0 1px 3px 0 rgba(25, 23, 36, 0.3), 0 1px 2px 0 rgba(25, 23, 36, 0.2)",
        lg: "0 10px 15px -3px rgba(25, 23, 36, 0.3), 0 4px 6px -2px rgba(25, 23, 36, 0.2)"
      }
    };
    kanagawa = {
      name: "kanagawa",
      colors: {
        primary: "#8ba4b0",
        secondary: "#a292a3",
        accent: "#c47fd5",
        success: "#76946a",
        warning: "#c0a36e",
        error: "#c34043",
        info: "#7e9cd8",
        light: "#dcd7ba",
        dark: "#1f1f28",
        muted: "#727169",
        highlight: "#2a2a37",
        text: {
          primary: "#dcd7ba",
          secondary: "#c8c093",
          muted: "#727169",
          light: "#ffffff"
        },
        background: {
          primary: "#1f1f28",
          secondary: "#2a2a37",
          dark: "#16161d"
        },
        border: {
          light: "#2a2a37",
          dark: "#000000"
        }
      },
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(31, 31, 40, 0.2)",
        base: "0 1px 3px 0 rgba(31, 31, 40, 0.3), 0 1px 2px 0 rgba(31, 31, 40, 0.2)",
        lg: "0 10px 15px -3px rgba(31, 31, 40, 0.3), 0 4px 6px -2px rgba(31, 31, 40, 0.2)"
      }
    };
    themes = {
      "ayu-dark": ayuDark,
      dracula,
      monokai,
      nord,
      "solarized-light": solarizedLight,
      "solarized-dark": solarizedDark,
      "tokyo-night": tokyoNight,
      github,
      gruvbox,
      "one-dark": oneDark,
      catppuccin,
      "rose-pine": rosePine,
      kanagawa
    };
  }
});

// packages/cli/src/ui/themes/theme-manager.ts
var defaultColors, defaultTheme, darkTheme, ThemeManager, themeManager;
var init_theme_manager = __esm({
  "packages/cli/src/ui/themes/theme-manager.ts"() {
    "use strict";
    init_theme();
    init_themes_presets();
    defaultColors = {
      primary: "#0066cc",
      secondary: "#6c757d",
      accent: "#e83e8c",
      success: "#28a745",
      warning: "#ffc107",
      error: "#dc3545",
      info: "#17a2b8",
      light: "#f8f9fa",
      dark: "#343a40",
      muted: "#6c757d",
      highlight: "#fff3cd",
      text: {
        primary: "#212529",
        secondary: "#6c757d",
        muted: "#6c757d",
        light: "#ffffff"
      },
      background: {
        primary: "#ffffff",
        secondary: "#f8f9fa",
        dark: "#343a40"
      },
      border: {
        light: "#dee2e6",
        dark: "#495057"
      }
    };
    defaultTheme = {
      name: "default",
      colors: defaultColors,
      spacing: {
        xs: 0.25,
        sm: 0.5,
        md: 1,
        lg: 1.5,
        xl: 2
      },
      typography: {
        fontSize: {
          xs: 0.75,
          sm: 0.875,
          base: 1,
          lg: 1.125,
          xl: 1.25,
          "2xl": 1.5,
          "3xl": 1.875
        },
        fontWeight: {
          light: 300,
          normal: 400,
          medium: 500,
          semibold: 600,
          bold: 700
        }
      },
      borderRadius: {
        sm: 0.125,
        base: 0.25,
        lg: 0.5,
        xl: 0.75
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
        base: "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)",
        lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)"
      }
    };
    darkTheme = {
      ...defaultTheme,
      name: "dark",
      colors: {
        ...defaultColors,
        text: {
          primary: "#ffffff",
          secondary: "#e2e8f0",
          muted: "#94a3b8",
          light: "#000000"
        },
        background: {
          primary: "#1e293b",
          secondary: "#334155",
          dark: "#0f172a"
        },
        border: {
          light: "#475569",
          dark: "#64748b"
        }
      }
    };
    ThemeManager = class {
      currentTheme = defaultTheme;
      themes = /* @__PURE__ */ new Map();
      constructor() {
        this.themes.set("default", defaultTheme);
        this.themes.set("dark", darkTheme);
        for (const [name, theme] of Object.entries(themes)) {
          this.themes.set(name, theme);
        }
      }
      /**
       * 设置当前主题
       * @param themeName 主题名称
       */
      setTheme(themeName) {
        const theme = this.themes.get(themeName);
        if (theme) {
          this.currentTheme = theme;
        } else {
          throw new Error(`Theme '${themeName}' not found`);
        }
      }
      /**
       * 获取当前主题
       * @returns 当前主题配置
       */
      getTheme() {
        return this.currentTheme;
      }
      /**
       * 添加新主题
       * @param name 主题名称
       * @param theme 主题配置
       */
      addTheme(name, theme) {
        if (!validateTheme(theme)) {
          throw new Error(`Invalid theme configuration for '${name}'`);
        }
        this.themes.set(name, theme);
      }
      /**
       * 获取所有可用主题名称
       * @returns 主题名称数组
       */
      getAvailableThemes() {
        return Array.from(this.themes.keys());
      }
      /**
       * 获取当前主题名称
       * @returns 当前主题名称
       */
      getCurrentThemeName() {
        return this.currentTheme.name;
      }
      /**
       * 通过名称获取主题
       * @param name 主题名称
       * @returns 主题配置或undefined
       */
      getThemeByName(name) {
        return this.themes.get(name);
      }
      /**
       * 移除主题
       * @param name 主题名称
       */
      removeTheme(name) {
        if (name === "default" || name === "dark" || Object.prototype.hasOwnProperty.call(themes, name)) {
          throw new Error(`Cannot remove built-in theme '${name}'`);
        }
        this.themes.delete(name);
      }
      /**
       * 检查主题是否存在
       * @param name 主题名称
       * @returns 是否存在
       */
      hasTheme(name) {
        return this.themes.has(name);
      }
      /**
       * 验证主题配置
       * @param theme 主题配置
       * @returns 是否有效
       */
      validateTheme(theme) {
        return validateTheme(theme);
      }
    };
    themeManager = new ThemeManager();
  }
});

// packages/cli/src/ui/themes/styles.ts
import chalk2 from "chalk";
var UIStyles, $;
var init_styles = __esm({
  "packages/cli/src/ui/themes/styles.ts"() {
    "use strict";
    init_theme_manager();
    UIStyles = {
      // 文本样式
      text: {
        bold: (text) => chalk2.bold(text),
        italic: (text) => chalk2.italic(text),
        underline: (text) => chalk2.underline(text),
        strikethrough: (text) => chalk2.strikethrough(text),
        dim: (text) => chalk2.dim(text)
      },
      // 状态样式
      status: {
        success: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.success)(text);
        },
        error: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.error)(text);
        },
        warning: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.warning)(text);
        },
        info: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.info)(text);
        },
        muted: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.muted)(text);
        }
      },
      // 语义化样式
      semantic: {
        primary: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.primary)(text);
        },
        secondary: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.secondary)(text);
        },
        accent: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.accent)(text);
        },
        highlight: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.bgHex(theme.colors.highlight).hex(theme.colors.text.primary)(text);
        }
      },
      // 标题样式
      heading: {
        h1: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.bold.hex(theme.colors.primary)(text);
        },
        h2: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.bold.hex(theme.colors.info)(text);
        },
        h3: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.bold.hex(theme.colors.success)(text);
        },
        h4: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.bold.hex(theme.colors.warning)(text);
        }
      },
      // 特殊组件样式
      component: {
        header: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.bold.hex(theme.colors.primary)(text);
        },
        section: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.info)(text);
        },
        label: (text) => chalk2.white(text),
        value: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.success)(text);
        },
        code: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.gray.bgHex(theme.colors.background.secondary)(` ${text} `);
        },
        quote: (text) => {
          const theme = themeManager.getTheme();
          return chalk2.italic.hex(theme.colors.text.secondary)(text);
        }
      },
      // 图标样式
      icon: {
        success: "\u2705",
        error: "\u274C",
        warning: "\u26A0\uFE0F",
        info: "\u2139\uFE0F",
        loading: "\u23F3",
        rocket: "\u{1F680}",
        gear: "\u2699\uFE0F",
        chat: "\u{1F4AC}",
        tools: "\u{1F527}",
        config: "\u{1F4CB}",
        mcp: "\u{1F517}"
      },
      // 边框和分隔符
      border: {
        line: (length = 50) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.border.light)("\u2500".repeat(length));
        },
        doubleLine: (length = 50) => {
          const theme = themeManager.getTheme();
          return chalk2.hex(theme.colors.border.dark)("\u2550".repeat(length));
        },
        box: {
          top: "\u250C",
          bottom: "\u2514",
          left: "\u2502",
          right: "\u2502",
          horizontal: "\u2500",
          vertical: "\u2502"
        }
      }
    };
    $ = {
      success: UIStyles.status.success,
      error: UIStyles.status.error,
      warning: UIStyles.status.warning,
      info: UIStyles.status.info,
      muted: UIStyles.status.muted,
      bold: UIStyles.text.bold,
      dim: UIStyles.text.dim,
      header: UIStyles.component.header,
      code: UIStyles.component.code
    };
  }
});

// packages/cli/src/ui/themes/semantic-colors.ts
var SemanticColorManager;
var init_semantic_colors = __esm({
  "packages/cli/src/ui/themes/semantic-colors.ts"() {
    "use strict";
    SemanticColorManager = class {
      theme;
      semanticColors;
      constructor(theme) {
        this.theme = theme;
        this.semanticColors = this.generateSemanticColors(theme);
      }
      /**
       * 生成语义化颜色映射
       * @param theme 主题配置
       * @returns 语义化颜色映射
       */
      generateSemanticColors(theme) {
        const { colors } = theme;
        return {
          text: {
            heading: colors.text.primary,
            body: colors.text.primary,
            caption: colors.text.secondary,
            link: colors.primary,
            success: colors.success,
            warning: colors.warning,
            error: colors.error,
            info: colors.info,
            disabled: colors.muted,
            inverted: colors.text.light
          },
          background: {
            page: colors.background.primary,
            card: colors.background.primary,
            modal: colors.background.primary,
            popover: colors.background.secondary,
            success: colors.success + "20",
            // 透明度处理
            warning: colors.warning + "20",
            error: colors.error + "20",
            info: colors.info + "20",
            disabled: colors.background.secondary,
            inverted: colors.background.dark
          },
          border: {
            default: colors.border.light,
            focus: colors.primary,
            success: colors.success,
            warning: colors.warning,
            error: colors.error,
            info: colors.info,
            disabled: colors.border.light,
            divider: colors.border.light
          },
          interactive: {
            primary: colors.primary,
            secondary: colors.secondary,
            accent: colors.accent,
            hover: this.adjustColorBrightness(colors.primary, 0.1),
            active: this.adjustColorBrightness(colors.primary, -0.1),
            focus: colors.primary,
            disabled: colors.muted
          },
          status: {
            success: colors.success,
            warning: colors.warning,
            error: colors.error,
            info: colors.info,
            pending: colors.warning,
            draft: colors.muted
          },
          functional: {
            highlight: colors.highlight,
            selection: colors.primary + "30",
            // 透明度处理
            overlay: colors.background.dark + "80",
            shadow: colors.border.dark + "20",
            backdrop: colors.background.dark + "60"
          }
        };
      }
      /**
       * 调整颜色亮度
       * @param color 原始颜色
       * @param amount 调整量 (-1 到 1)
       * @returns 调整后的颜色
       */
      adjustColorBrightness(color, amount) {
        const c = color.replace("#", "");
        let r = parseInt(c.substring(0, 2), 16);
        let g = parseInt(c.substring(2, 4), 16);
        let b = parseInt(c.substring(4, 6), 16);
        r = Math.min(255, Math.max(0, r + amount * 255));
        g = Math.min(255, Math.max(0, g + amount * 255));
        b = Math.min(255, Math.max(0, b + amount * 255));
        return `#${Math.round(r).toString(16).padStart(2, "0")}${Math.round(g).toString(16).padStart(2, "0")}${Math.round(b).toString(16).padStart(2, "0")}`;
      }
      /**
       * 更新主题
       * @param theme 新主题
       */
      updateTheme(theme) {
        this.theme = theme;
        this.semanticColors = this.generateSemanticColors(theme);
      }
      /**
       * 获取语义化颜色
       * @param category 颜色分类
       * @param key 颜色键名
       * @returns 颜色值
       */
      getColor(category, key) {
        const categoryColors = this.semanticColors[category];
        if (categoryColors && key in categoryColors) {
          return categoryColors[key];
        }
        return "#000000";
      }
      /**
       * 获取所有语义化颜色
       * @returns 语义化颜色映射
       */
      getAllColors() {
        return this.semanticColors;
      }
      /**
       * 获取文本语义色
       * @param key 键名
       * @returns 颜色值
       */
      getTextColor(key) {
        return this.semanticColors.text[key];
      }
      /**
       * 获取背景语义色
       * @param key 键名
       * @returns 颜色值
       */
      getBackgroundColor(key) {
        return this.semanticColors.background[key];
      }
      /**
       * 获取边框语义色
       * @param key 键名
       * @returns 颜色值
       */
      getBorderColor(key) {
        return this.semanticColors.border[key];
      }
      /**
       * 获取交互语义色
       * @param key 键名
       * @returns 颜色值
       */
      getInteractiveColor(key) {
        return this.semanticColors.interactive[key];
      }
      /**
       * 获取状态语义色
       * @param key 键名
       * @returns 颜色值
       */
      getStatusColor(key) {
        return this.semanticColors.status[key];
      }
      /**
       * 获取功能语义色
       * @param key 键名
       * @returns 颜色值
       */
      getFunctionalColor(key) {
        return this.semanticColors.functional[key];
      }
    };
  }
});

// packages/cli/src/ui/themes/index.ts
var themes_exports = {};
__export(themes_exports, {
  $: () => $,
  SemanticColorManager: () => SemanticColorManager,
  ThemeManager: () => ThemeManager,
  UIColors: () => UIColors,
  UIStyles: () => UIStyles,
  themeManager: () => themeManager
});
var init_themes = __esm({
  "packages/cli/src/ui/themes/index.ts"() {
    "use strict";
    init_colors();
    init_styles();
    init_theme_manager();
    init_semantic_colors();
  }
});

// packages/cli/src/blade.tsx
import React4, { useState as useState2, useCallback as useCallback2, useEffect } from "react";
import { render, Box as Box3, Text as Text3, useApp as useApp2 } from "ink";
import { Command } from "commander";

// packages/cli/src/contexts/SessionContext.tsx
import { createContext, useContext, useReducer } from "react";
import { jsx } from "react/jsx-runtime";
var SessionContext = createContext(void 0);
var initialState = {
  messages: [],
  isThinking: false,
  input: "",
  currentCommand: null,
  error: null,
  isActive: true
};
function sessionReducer(state, action) {
  switch (action.type) {
    case "ADD_MESSAGE":
      return {
        ...state,
        messages: [...state.messages, action.payload],
        error: null
        // 清除错误当有新消息时
      };
    case "SET_INPUT":
      return { ...state, input: action.payload };
    case "SET_THINKING":
      return { ...state, isThinking: action.payload };
    case "SET_COMMAND":
      return { ...state, currentCommand: action.payload };
    case "SET_ERROR":
      return { ...state, error: action.payload };
    case "CLEAR_MESSAGES":
      return { ...state, messages: [], error: null };
    case "RESET_SESSION":
      return { ...initialState, isActive: true };
    default:
      return state;
  }
}
function SessionProvider({ children }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const addUserMessage = (content) => {
    const message = {
      id: Date.now().toString(),
      role: "user",
      content,
      timestamp: Date.now()
    };
    dispatch({ type: "ADD_MESSAGE", payload: message });
  };
  const addAssistantMessage = (content) => {
    const message = {
      id: Date.now().toString(),
      role: "assistant",
      content,
      timestamp: Date.now()
    };
    dispatch({ type: "ADD_MESSAGE", payload: message });
  };
  const clearMessages = () => {
    dispatch({ type: "CLEAR_MESSAGES" });
  };
  const resetSession = () => {
    dispatch({ type: "RESET_SESSION" });
  };
  const value = {
    state,
    dispatch,
    addUserMessage,
    addAssistantMessage,
    clearMessages,
    resetSession
  };
  return /* @__PURE__ */ jsx(SessionContext.Provider, { value, children });
}
function useSession() {
  const context = useContext(SessionContext);
  if (context === void 0) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return context;
}

// packages/cli/src/components/EnhancedReplInterface.tsx
import { useState, useCallback } from "react";
import { Box, Text, useInput, useApp, Spacer } from "ink";
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
var EnhancedReplInterface = ({
  onCommandSubmit,
  onClear,
  onExit
}) => {
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const { state: sessionState, dispatch } = useSession();
  const { exit } = useApp();
  const handleSubmit = useCallback(async () => {
    if (input.trim() && !isProcessing) {
      const command = input.trim();
      setCommandHistory((prev) => [...prev, command]);
      setHistoryIndex(-1);
      setIsProcessing(true);
      dispatch({ type: "SET_THINKING", payload: true });
      try {
        const result = await onCommandSubmit(command);
        if (!result.success && result.error) {
          dispatch({ type: "SET_ERROR", payload: result.error });
        }
        setInput("");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF";
        dispatch({ type: "SET_ERROR", payload: `\u6267\u884C\u5931\u8D25: ${errorMessage}` });
      } finally {
        setIsProcessing(false);
        dispatch({ type: "SET_THINKING", payload: false });
      }
    }
  }, [input, isProcessing, onCommandSubmit, dispatch]);
  const handleClear = useCallback(() => {
    onClear();
    dispatch({ type: "CLEAR_MESSAGES" });
    dispatch({ type: "SET_ERROR", payload: null });
  }, [onClear, dispatch]);
  const handleExit = useCallback(() => {
    onExit();
    exit();
  }, [onExit, exit]);
  useInput((inputKey, key) => {
    if (key.return) {
      handleSubmit();
    } else if (key.ctrl && key.name === "c") {
      handleExit();
    } else if (key.ctrl && key.name === "l") {
      handleClear();
    } else if (key.upArrow && commandHistory.length > 0) {
      const newIndex = historyIndex === -1 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setInput(commandHistory[newIndex] || "");
    } else if (key.downArrow) {
      if (historyIndex !== -1) {
        const newIndex = historyIndex + 1;
        if (newIndex >= commandHistory.length) {
          setHistoryIndex(-1);
          setInput("");
        } else {
          setHistoryIndex(newIndex);
          setInput(commandHistory[newIndex] || "");
        }
      }
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (inputKey && key.name !== "escape") {
      setInput((prev) => prev + inputKey);
    }
  });
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", width: "100%", height: "100%", children: [
    /* @__PURE__ */ jsxs(Box, { flexDirection: "row", justifyContent: "space-between", paddingX: 1, paddingY: 0, children: [
      /* @__PURE__ */ jsx2(Text, { color: "blue", children: "\u{1F916} Blade AI \u52A9\u624B" }),
      /* @__PURE__ */ jsx2(Text, { color: "gray", children: "Ctrl+C \u9000\u51FA | Ctrl+L \u6E05\u5C4F" })
    ] }),
    /* @__PURE__ */ jsxs(Box, { height: 1, width: "100%", children: [
      /* @__PURE__ */ jsx2(Text, { color: "gray", children: "\u2500" }),
      /* @__PURE__ */ jsx2(Spacer, {}),
      /* @__PURE__ */ jsx2(Text, { color: "gray", children: "\u2500" })
    ] }),
    /* @__PURE__ */ jsxs(Box, { flexDirection: "column", flexGrow: 1, paddingX: 1, paddingY: 0, children: [
      sessionState.messages.length === 0 && !sessionState.error && /* @__PURE__ */ jsxs(Box, { flexDirection: "column", paddingY: 1, children: [
        /* @__PURE__ */ jsx2(Text, { color: "blue", children: "\u{1F680} \u6B22\u8FCE\u4F7F\u7528 Blade AI \u52A9\u624B!" }),
        /* @__PURE__ */ jsx2(Text, { children: " " }),
        /* @__PURE__ */ jsx2(Text, { color: "gray", children: "\u8F93\u5165 /help \u67E5\u770B\u53EF\u7528\u547D\u4EE4" }),
        /* @__PURE__ */ jsx2(Text, { color: "gray", children: "\u76F4\u63A5\u8F93\u5165\u95EE\u9898\u5F00\u59CB\u5BF9\u8BDD" })
      ] }),
      sessionState.messages.map((message) => /* @__PURE__ */ jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [
        /* @__PURE__ */ jsx2(Box, { children: /* @__PURE__ */ jsx2(Text, { color: message.role === "user" ? "green" : "blue", children: message.role === "user" ? "\u{1F464} \u4F60: " : "\u{1F916} \u52A9\u624B: " }) }),
        /* @__PURE__ */ jsx2(Box, { marginLeft: 3, children: /* @__PURE__ */ jsx2(Text, { children: message.content }) })
      ] }, message.id)),
      isProcessing && /* @__PURE__ */ jsx2(Box, { flexDirection: "column", marginBottom: 1, children: /* @__PURE__ */ jsx2(Box, { children: /* @__PURE__ */ jsx2(Text, { color: "yellow", children: "\u23F3 \u52A9\u624B\u6B63\u5728\u601D\u8003..." }) }) }),
      sessionState.error && /* @__PURE__ */ jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [
        /* @__PURE__ */ jsx2(Box, { children: /* @__PURE__ */ jsx2(Text, { color: "red", children: "\u274C \u9519\u8BEF: " }) }),
        /* @__PURE__ */ jsx2(Box, { marginLeft: 3, children: /* @__PURE__ */ jsx2(Text, { color: "red", children: sessionState.error }) })
      ] })
    ] }),
    /* @__PURE__ */ jsxs(Box, { flexDirection: "row", alignItems: "center", paddingX: 1, paddingY: 1, children: [
      /* @__PURE__ */ jsx2(Text, { color: "green", children: ">>> " }),
      /* @__PURE__ */ jsx2(Text, { children: input }),
      isProcessing && /* @__PURE__ */ jsx2(Text, { color: "yellow", children: "|" })
    ] }),
    /* @__PURE__ */ jsxs(Box, { flexDirection: "row", justifyContent: "space-between", paddingX: 1, paddingY: 0, children: [
      /* @__PURE__ */ jsx2(Text, { color: "gray", children: sessionState.messages.length > 0 ? `${sessionState.messages.length} \u6761\u6D88\u606F` : "\u6682\u65E0\u6D88\u606F" }),
      /* @__PURE__ */ jsx2(Text, { color: "gray", children: isProcessing ? "\u5904\u7406\u4E2D..." : "\u5C31\u7EEA" })
    ] })
  ] });
};

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path: path6, errorMaps, issueData } = params;
  const fullPath = [...path6, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message == null ? void 0 : message.message;
})(errorUtil || (errorUtil = {}));

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path6, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path6;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: (params == null ? void 0 : params.async) ?? false,
        contextualErrorMap: params == null ? void 0 : params.errorMap
      },
      path: (params == null ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    var _a, _b;
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if ((_b = (_a = err == null ? void 0 : err.message) == null ? void 0 : _a.toLowerCase()) == null ? void 0 : _b.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params == null ? void 0 : params.errorMap,
        async: true
      },
      path: (params == null ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && (decoded == null ? void 0 : decoded.typ) !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof (options == null ? void 0 : options.precision) === "undefined" ? null : options == null ? void 0 : options.precision,
      offset: (options == null ? void 0 : options.offset) ?? false,
      local: (options == null ? void 0 : options.local) ?? false,
      ...errorUtil.errToObj(options == null ? void 0 : options.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof (options == null ? void 0 : options.precision) === "undefined" ? null : options == null ? void 0 : options.precision,
      ...errorUtil.errToObj(options == null ? void 0 : options.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options == null ? void 0 : options.position,
      ...errorUtil.errToObj(options == null ? void 0 : options.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: (params == null ? void 0 : params.coerce) ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: (params == null ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: (params == null ? void 0 : params.coerce) ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: (params == null ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: (params == null ? void 0 : params.coerce) || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          var _a, _b;
          const defaultError = ((_b = (_a = this._def).errorMap) == null ? void 0 : _b.call(_a, issue, ctx).message) ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;

// packages/core/src/types/config.ts
var AuthConfigSchema = external_exports.object({
  apiKey: external_exports.string().default(""),
  baseUrl: external_exports.string().url().default("https://apis.iflow.cn/v1"),
  modelName: external_exports.string().default("Qwen3-Coder"),
  searchApiKey: external_exports.string().default("")
});
var UIConfigSchema = external_exports.object({
  theme: external_exports.enum(["GitHub", "dark", "light", "auto"]).default("GitHub"),
  hideTips: external_exports.boolean().default(false),
  hideBanner: external_exports.boolean().default(false)
});
var SecurityConfigSchema = external_exports.object({
  sandbox: external_exports.enum(["docker", "none"]).default("docker"),
  trustedFolders: external_exports.array(external_exports.string()).default([]),
  allowedOperations: external_exports.array(external_exports.string()).default(["read", "write", "execute"])
});
var ToolsConfigSchema = external_exports.object({
  toolDiscoveryCommand: external_exports.string().default("bin/get_tools"),
  toolCallCommand: external_exports.string().default("bin/call_tool"),
  summarizeToolOutput: external_exports.record(
    external_exports.object({
      tokenBudget: external_exports.number().min(1).optional()
    })
  ).default({})
});
var MCPConfigSchema = external_exports.object({
  mcpServers: external_exports.record(
    external_exports.object({
      command: external_exports.string(),
      args: external_exports.array(external_exports.string()).optional(),
      env: external_exports.record(external_exports.string()).optional()
    })
  ).default({
    main: {
      command: "bin/mcp_server.py"
    }
  })
});
var TelemetryConfigSchema = external_exports.object({
  enabled: external_exports.boolean().default(true),
  target: external_exports.enum(["local", "remote"]).default("local"),
  otlpEndpoint: external_exports.string().url().default("http://localhost:4317"),
  logPrompts: external_exports.boolean().default(false)
});
var UsageConfigSchema = external_exports.object({
  usageStatisticsEnabled: external_exports.boolean().default(true),
  maxSessionTurns: external_exports.number().min(1).max(100).default(10),
  rateLimit: external_exports.object({
    requestsPerMinute: external_exports.number().min(1).default(60),
    requestsPerHour: external_exports.number().min(1).default(3600)
  }).default({
    requestsPerMinute: 60,
    requestsPerHour: 3600
  })
});
var DebugConfigSchema = external_exports.object({
  debug: external_exports.boolean().default(false),
  logLevel: external_exports.enum(["error", "warn", "info", "debug", "trace"]).default("info"),
  logToFile: external_exports.boolean().default(false),
  logFilePath: external_exports.string().default("./logs/blade.log")
});
var GlobalConfigSchema = external_exports.object({
  auth: AuthConfigSchema.default({}),
  ui: UIConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  mcp: MCPConfigSchema.default({}),
  telemetry: TelemetryConfigSchema.default({}),
  usage: UsageConfigSchema.default({}),
  debug: DebugConfigSchema.default({}),
  version: external_exports.string().default("1.0.0"),
  createdAt: external_exports.string().datetime().default(() => (/* @__PURE__ */ new Date()).toISOString())
});
var EnvConfigSchema = external_exports.object({
  auth: AuthConfigSchema.partial().default({}),
  ui: UIConfigSchema.partial().default({}),
  security: SecurityConfigSchema.partial().default({}),
  tools: ToolsConfigSchema.partial().default({}),
  mcp: MCPConfigSchema.partial().default({}),
  telemetry: TelemetryConfigSchema.partial().default({}),
  usage: UsageConfigSchema.partial().default({}),
  debug: DebugConfigSchema.partial().default({})
});
var UserConfigSchema = external_exports.object({
  auth: AuthConfigSchema.partial().default({}),
  ui: UIConfigSchema.partial().default({}),
  security: SecurityConfigSchema.partial().default({}),
  tools: ToolsConfigSchema.partial().default({}),
  mcp: MCPConfigSchema.partial().default({}),
  telemetry: TelemetryConfigSchema.partial().default({}),
  usage: UsageConfigSchema.partial().default({}),
  debug: DebugConfigSchema.partial().default({}),
  currentProvider: external_exports.enum(["qwen", "volcengine"]).optional(),
  currentModel: external_exports.string().optional(),
  lastUpdated: external_exports.string().datetime().optional(),
  preferences: external_exports.object({
    autoSave: external_exports.boolean().default(true),
    backupEnabled: external_exports.boolean().default(true),
    backupInterval: external_exports.number().min(1).default(3600)
    // 秒
  }).default({})
});
var ProjectConfigSchema = external_exports.object({
  auth: AuthConfigSchema.partial().default({}),
  ui: UIConfigSchema.partial().default({}),
  security: SecurityConfigSchema.partial().default({}),
  tools: ToolsConfigSchema.partial().default({}),
  mcp: MCPConfigSchema.partial().default({}),
  telemetry: TelemetryConfigSchema.partial().default({}),
  usage: UsageConfigSchema.partial().default({}),
  debug: DebugConfigSchema.partial().default({}),
  projectSpecific: external_exports.object({
    enabled: external_exports.boolean().default(true),
    overridesGlobal: external_exports.boolean().default(false),
    inheritFromParent: external_exports.boolean().default(true)
  }).default({})
});
var BladeUnifiedConfigSchema = external_exports.object({
  auth: AuthConfigSchema,
  ui: UIConfigSchema,
  security: SecurityConfigSchema,
  tools: ToolsConfigSchema,
  mcp: MCPConfigSchema,
  telemetry: TelemetryConfigSchema,
  usage: UsageConfigSchema,
  debug: DebugConfigSchema,
  metadata: external_exports.object({
    sources: external_exports.array(external_exports.enum(["global", "env", "user", "project"])).default(["global"]),
    loadedAt: external_exports.string().datetime().default(() => (/* @__PURE__ */ new Date()).toISOString()),
    configVersion: external_exports.string().default("1.0.0"),
    validationErrors: external_exports.array(external_exports.string()).default([])
  }).default({
    sources: ["global"],
    loadedAt: (/* @__PURE__ */ new Date()).toISOString(),
    configVersion: "1.0.0",
    validationErrors: []
  })
});
var ConfigStateSchema = external_exports.object({
  isValid: external_exports.boolean(),
  errors: external_exports.array(external_exports.string()),
  warnings: external_exports.array(external_exports.string()),
  lastReload: external_exports.string().datetime(),
  configVersion: external_exports.string()
});
var CONFIG_PATHS = {
  global: {
    userConfig: `${process.env.HOME || process.env.USERPROFILE}/.blade/config.json`,
    userConfigLegacy: `${process.env.HOME || process.env.USERPROFILE}/.blade-config.json`,
    trustedFolders: `${process.env.HOME || process.env.USERPROFILE}/.blade/trusted-folders.json`
  },
  project: {
    bladeConfig: "./.blade/settings.local.json",
    packageJson: "./package.json",
    bladeConfigRoot: "./.blade/config.json"
  },
  env: {
    configFile: process.env.BLADE_CONFIG_FILE || ""
  }
};

// packages/core/src/config/index.ts
function createConfig(layers, options = {}) {
  const {
    validate = true,
    throwOnError = false,
    priority = ["env" /* ENV */, "user" /* USER */, "project" /* PROJECT */, "global" /* GLOBAL */]
  } = options;
  const warnings = [];
  const errors = [];
  try {
    const reversedPriority = priority.slice().reverse();
    let merged = {};
    for (const layer of reversedPriority) {
      const layerConfig = layers[layer.toLowerCase()];
      if (layerConfig) {
        merged = deepMerge(merged, layerConfig, /* @__PURE__ */ new WeakSet());
      }
    }
    const configWithDefaults = ensureRequiredFields(merged);
    if (validate) {
      const validationResult = BladeUnifiedConfigSchema.safeParse(configWithDefaults);
      if (!validationResult.success) {
        const formattedErrors = validationResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
        errors.push(...formattedErrors);
      }
    }
    if (errors.length > 0 && throwOnError) {
      throw new Error(`\u914D\u7F6E\u9A8C\u8BC1\u5931\u8D25: ${errors.join(", ")}`);
    }
    return {
      config: configWithDefaults,
      warnings,
      errors
    };
  } catch (error) {
    if (throwOnError) {
      throw error;
    }
    errors.push(error instanceof Error ? error.message : "\u672A\u77E5\u914D\u7F6E\u5408\u5E76\u9519\u8BEF");
    return {
      config: createDefaultConfig(),
      warnings,
      errors
    };
  }
}
function deepMerge(target, source, seen = /* @__PURE__ */ new WeakSet()) {
  if (source === null || typeof source !== "object") {
    return source;
  }
  if (seen.has(source)) {
    return "[Circular]";
  }
  seen.add(source);
  if (Array.isArray(source)) {
    return [...Array.isArray(target) ? target : [], ...source];
  }
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === void 0) {
      continue;
    }
    if (key in result && typeof result[key] === "object" && typeof value === "object") {
      result[key] = deepMerge(result[key], value, seen);
    } else {
      result[key] = value;
    }
  }
  return result;
}
function ensureRequiredFields(config) {
  const result = { ...config };
  result.auth = { ...AuthConfigSchema.parse({}), ...result.auth || {} };
  result.ui = { ...UIConfigSchema.parse({}), ...result.ui || {} };
  result.security = { ...SecurityConfigSchema.parse({}), ...result.security || {} };
  result.tools = { ...ToolsConfigSchema.parse({}), ...result.tools || {} };
  result.mcp = { ...MCPConfigSchema.parse({}), ...result.mcp || {} };
  result.telemetry = { ...TelemetryConfigSchema.parse({}), ...result.telemetry || {} };
  result.usage = { ...UsageConfigSchema.parse({}), ...result.usage || {} };
  result.debug = { ...DebugConfigSchema.parse({}), ...result.debug || {} };
  result.metadata = {
    sources: ["global"],
    loadedAt: (/* @__PURE__ */ new Date()).toISOString(),
    configVersion: "1.0.0",
    validationErrors: [],
    ...result.metadata || {}
  };
  return result;
}
function createDefaultConfig() {
  return BladeUnifiedConfigSchema.parse({
    auth: AuthConfigSchema.parse({}),
    ui: UIConfigSchema.parse({}),
    security: SecurityConfigSchema.parse({}),
    tools: ToolsConfigSchema.parse({}),
    mcp: MCPConfigSchema.parse({}),
    telemetry: TelemetryConfigSchema.parse({}),
    usage: UsageConfigSchema.parse({}),
    debug: DebugConfigSchema.parse({}),
    metadata: {
      sources: ["global"],
      loadedAt: (/* @__PURE__ */ new Date()).toISOString(),
      configVersion: "1.0.0",
      validationErrors: []
    }
  });
}

// packages/core/src/utils/secure-http-client.ts
import axios from "axios";
import https from "https";
var SecureHttpClient = class {
  client;
  rateLimitMap = /* @__PURE__ */ new Map();
  options;
  constructor(options = {}) {
    this.options = {
      baseURL: options.baseURL || "",
      timeout: options.timeout || 3e4,
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 1e3,
      validateCertificates: options.validateCertificates !== false,
      enforceTLS12: options.enforceTLS12 !== false,
      allowedHosts: options.allowedHosts || [],
      rateLimit: options.rateLimit || { requests: 100, period: 6e4 }
    };
    this.client = this.createSecureClient();
  }
  /**
   * 创建安全的 Axios 客户端
   */
  createSecureClient() {
    const agent = new https.Agent({
      // 强制 TLS 1.2+
      secureProtocol: this.options.enforceTLS12 ? "TLSv1_2_method" : void 0,
      // 验证证书
      rejectUnauthorized: this.options.validateCertificates
    });
    const client = axios.create({
      baseURL: this.options.baseURL,
      timeout: this.options.timeout,
      httpsAgent: agent
    });
    client.interceptors.request.use(
      (config) => {
        if (this.options.allowedHosts && this.options.allowedHosts.length > 0) {
          const url = new URL(config.url || "", config.baseURL);
          if (!this.options.allowedHosts.includes(url.hostname)) {
            throw new Error(`Host ${url.hostname} is not allowed`);
          }
        }
        if (this.options.rateLimit) {
          const now = Date.now();
          const host = config.url ? new URL(config.url, config.baseURL).hostname : "default";
          const rateLimitInfo = this.rateLimitMap.get(host);
          if (rateLimitInfo) {
            if (now < rateLimitInfo.resetTime) {
              if (rateLimitInfo.count >= this.options.rateLimit.requests) {
                throw new Error(`Rate limit exceeded for host ${host}`);
              }
              rateLimitInfo.count++;
            } else {
              rateLimitInfo.count = 1;
              rateLimitInfo.resetTime = now + this.options.rateLimit.period;
            }
          } else {
            this.rateLimitMap.set(host, {
              count: 1,
              resetTime: now + this.options.rateLimit.period
            });
          }
        }
        return config;
      },
      (error) => Promise.reject(error)
    );
    return client;
  }
  /**
   * GET 请求
   */
  async get(url, config) {
    return this.request({ ...config, method: "GET", url });
  }
  /**
   * POST 请求
   */
  async post(url, data, config) {
    return this.request({ ...config, method: "POST", url, data });
  }
  /**
   * PUT 请求
   */
  async put(url, data, config) {
    return this.request({ ...config, method: "PUT", url, data });
  }
  /**
   * DELETE 请求
   */
  async delete(url, config) {
    return this.request({ ...config, method: "DELETE", url });
  }
  /**
   * 通用请求方法
   */
  async request(config) {
    let lastError;
    for (let attempt = 0; attempt <= this.options.retryAttempts; attempt++) {
      try {
        const response = await this.client.request(config);
        return response;
      } catch (error) {
        lastError = error;
        if (!this.shouldRetry(error) || attempt === this.options.retryAttempts) {
          throw error;
        }
        await new Promise((resolve5) => setTimeout(resolve5, this.options.retryDelay * Math.pow(2, attempt)));
      }
    }
    throw lastError;
  }
  /**
   * 判断是否应该重试
   */
  shouldRetry(error) {
    const retryableCodes = [
      "ECONNRESET",
      "ECONNABORTED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN"
    ];
    const retryableStatus = [408, 429, 500, 502, 503, 504];
    return retryableCodes.includes(error.code) || error.response && retryableStatus.includes(error.response.status);
  }
};
var secureHttpClient = new SecureHttpClient();

// packages/core/src/utils/path-security.ts
import { resolve, normalize, relative, join } from "path";
import { constants, accessSync } from "fs";
import { homedir } from "os";
var PathSecurity = class {
  static ALLOWED_SCHEMES = ["file:", ""];
  static MAX_PATH_LENGTH = 4096;
  // Linux MAX_PATH
  static SUSPICIOUS_PATTERNS = [
    /\.\.\//g,
    // 相对路径
    /\.\.\\/g,
    // Windows 相对路径
    /^[/\\]/,
    // 绝对路径
    /~\//,
    // Home 目录简写
    /\$[A-Z_]/
    // 环境变量
  ];
  /**
   * 安全地解析和验证文件路径
   * @param userPath 用户提供的路径
   * @param baseDir 允许的基础目录（可选）
   * @param options 配置选项
   * @returns 解析后的安全路径
   * @throws Error 如果路径不安全
   */
  static async securePath(userPath, baseDir, options = {}) {
    var _a;
    const {
      allowAbsolute = false,
      checkExistence = false,
      allowedExtensions,
      maxDepth = 10
    } = options;
    if (!userPath || typeof userPath !== "string") {
      throw new Error("\u8DEF\u5F84\u4E0D\u80FD\u4E3A\u7A7A");
    }
    if (userPath.length > this.MAX_PATH_LENGTH) {
      throw new Error("\u8DEF\u5F84\u8FC7\u957F");
    }
    const hasScheme = /^[a-zA-Z]+:/.test(userPath);
    if (hasScheme) {
      const scheme = userPath.split(":")[0] + ":";
      if (!this.ALLOWED_SCHEMES.includes(scheme)) {
        throw new Error(`\u4E0D\u652F\u6301\u7684\u8DEF\u5F84\u534F\u8BAE: ${scheme}`);
      }
      userPath = userPath.substring(scheme.length);
    }
    let expandedPath = userPath;
    if (userPath.startsWith("~/")) {
      expandedPath = join(homedir(), userPath.substring(2));
    }
    const normalizedPath = normalize(expandedPath);
    for (const pattern of this.SUSPICIOUS_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        throw new Error("\u68C0\u6D4B\u5230\u6F5C\u5728\u7684\u8DEF\u5F84\u904D\u5386\u653B\u51FB");
      }
    }
    const resolvedPath = resolve(baseDir || process.cwd(), normalizedPath);
    if (baseDir) {
      const normalizedBase = normalize(baseDir);
      const relativePath = relative(normalizedBase, resolvedPath);
      if (relativePath.startsWith("..") || relativePath === "" || this.countPathSegments(relativePath) > maxDepth) {
        throw new Error("\u8DEF\u5F84\u8D85\u51FA\u5141\u8BB8\u7684\u76EE\u5F55\u8303\u56F4");
      }
    } else if (!allowAbsolute && !resolvedPath.startsWith(process.cwd())) {
      const relativePath = relative(process.cwd(), resolvedPath);
      if (relativePath.startsWith("..")) {
        throw new Error("\u53EA\u80FD\u5728\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u5185\u64CD\u4F5C");
      }
    }
    if (allowedExtensions) {
      const ext = (_a = resolvedPath.split(".").pop()) == null ? void 0 : _a.toLowerCase();
      const extWithDot = ext ? `.${ext}` : "";
      if (!allowedExtensions.some(
        (allowed) => allowed === extWithDot || allowed === ext
      )) {
        throw new Error(`\u4E0D\u652F\u6301\u7684\u6587\u4EF6\u7C7B\u578B: ${extWithDot}`);
      }
    }
    if (checkExistence) {
      try {
        accessSync(resolvedPath, constants.F_OK);
      } catch {
        throw new Error("\u8DEF\u5F84\u4E0D\u5B58\u5728");
      }
    }
    return resolvedPath;
  }
  /**
   * 检查路径是否在安全范围内
   * @param path 要检查的路径
   * @param allowedDirs 允许的目录列表
   */
  static isInAllowedDirs(path6, allowedDirs) {
    const resolvedPath = resolve(path6);
    return allowedDirs.some((dir) => {
      const resolvedDir = resolve(dir);
      const relativePath = relative(resolvedDir, resolvedPath);
      return !relativePath.startsWith("..");
    });
  }
  /**
   * 获取安全的临时文件路径
   * @param prefix 文件名前缀
   * @param extension 文件扩展名
   */
  static getSafeTempPath(prefix = "blade", extension = "tmp") {
    const tempDir = __require("os").tmpdir();
    const randomSuffix = Math.random().toString(36).substring(2, 15);
    const filename = `${prefix}-${randomSuffix}.${extension}`;
    return join(tempDir, filename);
  }
  /**
   * 清理路径中的危险字符
   * @param path 要清理的路径
   */
  static sanitizePath(path6) {
    return path6.replace(/[<>:"|?*]/g, "_").replace(/\s+/g, "_").replace(/^\./, "_").replace(/\.$/, "_").substring(0, 255);
  }
  /**
   * 计算路径段数
   */
  static countPathSegments(path6) {
    return path6.split(/[\\/]/).filter(Boolean).length;
  }
  /**
   * 获取默认的允许目录列表
   */
  static getDefaultAllowedDirs() {
    return [
      process.cwd(),
      join(homedir(), ".blade"),
      join(homedir(), ".config", "blade"),
      __require("os").tmpdir()
    ];
  }
};
var pathSecurity = new PathSecurity();

// packages/core/src/utils/error-handler.ts
var ErrorHandler = class {
  // 敏感信息模式
  static SENSITIVE_PATTERNS = /* @__PURE__ */ new Map([
    // API Keys
    [/apiKey["\']?\s*[:=]\s*["\']([^"']+)["\']/gi, "apiKey=[REDACTED]"],
    [/api["\']?\s*[:]\s*["\']([^"']+)["\']/gi, "api=[REDACTED]"],
    [/token["\']?\s*[:=]\s*["\']([^"']+)["\']/gi, "token=[REDACTED]"],
    [/secret["\']?\s*[:=]\s*["\']([^"']+)["\']/gi, "secret=[REDACTED]"],
    // 认证信息
    [/password["\']?\s*[:=]\s*["\']([^"']+)["\']/gi, "password=[REDACTED]"],
    [/credential["\']?\s*[:=]\s*["\']([^"']+)["\']/gi, "credential=[REDACTED]"],
    [/auth["\']?\s*[:]\s*["\']([^"']+)["\']/gi, "auth=[REDACTED]"],
    // URL 中的认证
    [/\/\/[^:@]+:[^@]+@/g, "//[REDACTED_USER]:[REDACTED_PASS]@"],
    // 环境变量
    [/process\.env\.[a-zA-Z_][a-zA-Z0-9_]*/gi, "process.env.[REDACTED_VAR]"],
    // 本地文件路径
    [/[a-zA-Z]:\\[^\\\]]*/gi, "[REDACTED_PATH]"],
    [/\/(home|Users)\/[^\/\]]+\/[^\/\]]*/gi, "[REDACTED_USER_PATH]"],
    [/\/tmp\/[^\/\]]*/gi, "[REDACTED_TMP_PATH]"],
    [/\.config\/[^\/\]]*/gi, "[REDACTED_CONFIG_PATH]"],
    // 数据库连接字符串
    [/mongodb:\/\/[^:@]+:[^@]+@/gi, "mongodb://[REDACTED_USER]:[REDACTED_PASS]@"],
    [/postgresql:\/\/[^:@]+:[^@]+@/gi, "postgresql://[REDACTED_USER]:[REDACTED_PASS]@"],
    [/mysql:\/\/[^:@]+:[^@]+@/gi, "mysql://[REDACTED_USER]:[REDACTED_PASS]@"],
    // AWS 凭证
    [/AKIA[0-9A-Z]{16}/gi, "[REDACTED_AWS_KEY]"],
    // 其他敏感信息
    [/Bearer [a-zA-Z0-9_\-\.=+/]{50,}/gi, "Bearer [REDACTED_TOKEN]"],
    [/sk-[a-zA-Z0-9_\-\.=+/]{20,}/gi, "[REDACTED_SK]"]
  ]);
  // 错误代码映射
  static ERROR_CODE_MAPPING = /* @__PURE__ */ new Map([
    ["ENOENT", { code: "FILE_NOT_FOUND", message: "\u6587\u4EF6\u4E0D\u5B58\u5728" }],
    ["EACCES", { code: "PERMISSION_DENIED", message: "\u6743\u9650\u4E0D\u8DB3" }],
    ["EISDIR", { code: "IS_DIRECTORY", message: "\u76EE\u6807\u662F\u4E00\u4E2A\u76EE\u5F55" }],
    ["ENOTDIR", { code: "NOT_DIRECTORY", message: "\u76EE\u6807\u4E0D\u662F\u76EE\u5F55" }],
    ["EEXIST", { code: "FILE_EXISTS", message: "\u6587\u4EF6\u5DF2\u5B58\u5728" }],
    ["EINVAL", { code: "INVALID_ARGUMENT", message: "\u65E0\u6548\u53C2\u6570" }],
    ["ENOTEMPTY", { code: "DIRECTORY_NOT_EMPTY", message: "\u76EE\u5F55\u4E0D\u4E3A\u7A7A" }],
    ["EMFILE", { code: "TOO_MANY_FILES", message: "\u6253\u5F00\u7684\u6587\u4EF6\u8FC7\u591A" }],
    ["ETIMEDOUT", { code: "TIMEOUT", message: "\u64CD\u4F5C\u8D85\u65F6" }],
    ["ECONNREFUSED", { code: "CONNECTION_REFUSED", message: "\u8FDE\u63A5\u88AB\u62D2\u7EDD" }],
    ["ENOTFOUND", { code: "HOST_NOT_FOUND", message: "\u4E3B\u673A\u672A\u627E\u5230" }]
  ]);
  /**
   * 创建用户友好的错误信息
   * @param error 原始错误
   * @param options 选项
   * @returns 用户友好的错误信息
   */
  static createFriendlyError(error, options = {}) {
    const { includeCode = false, includeStack = false, context = {} } = options;
    const errorObj = typeof error === "string" ? new Error(error) : error;
    const sanitizedMessage = this.sanitizeError(errorObj.message);
    const errorCode = this.getErrorCode(errorObj);
    const errorData = {
      code: errorCode.code,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      context: this.sanitizeContext(context)
    };
    if (includeStack && errorObj.stack) {
      errorData.stack = this.sanitizeStack(errorObj.stack);
    }
    let userMessage = errorCode.message || sanitizedMessage;
    const solution = this.getSolution(errorCode.code);
    if (solution) {
      userMessage += `
\u5EFA\u8BAE: ${solution}`;
    }
    return {
      success: false,
      error: userMessage,
      code: includeCode ? errorCode.code : void 0,
      data: process.env.NODE_ENV === "development" ? errorData : void 0
    };
  }
  /**
   * 脱敏错误消息
   * @param errorMessage 错误消息
   * @returns 脱敏后的消息
   */
  static sanitizeError(errorMessage) {
    let sanitized = errorMessage;
    for (const [pattern, replacement] of this.SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, replacement);
    }
    if (sanitized.includes("/") || sanitized.includes("\\")) {
      sanitized = this.sanitizeFilePaths(sanitized);
    }
    sanitized = sanitized.replace(/\b\d{4,}\b/g, "[ID]");
    if (sanitized.length > 500) {
      sanitized = sanitized.substring(0, 497) + "...";
    }
    return sanitized.trim();
  }
  /**
   * 脱敏文件路径
   * @param text 包含路径的文本
   * @returns 脱敏后的文本
   */
  static sanitizeFilePaths(text) {
    const homeDir = __require("os").homedir();
    if (text.includes(homeDir)) {
      text = text.replace(new RegExp(homeDir, "g"), "~");
    }
    const cwd = process.cwd();
    if (text.includes(cwd)) {
      text = text.replace(new RegExp(cwd, "g"), "[CWD]");
    }
    try {
      const paths = text.match(/\/[^\\\s\]]+|\\[^\\\s\]]+/g) || [];
      for (const path6 of paths) {
        if (path6.length > 20) {
          const filename = path6.split(/[\\/]/).pop() || "";
          text = text.replace(path6, `[PATH]${filename ? `/${filename}` : ""}`);
        }
      }
    } catch {
    }
    return text;
  }
  /**
   * 获取标准化错误代码
   * @param error 错误对象
   * @returns 标准化错误代码和信息
   */
  static getErrorCode(error) {
    const nodeCode = error.code;
    if (nodeCode && this.ERROR_CODE_MAPPING.has(nodeCode)) {
      return this.ERROR_CODE_MAPPING.get(nodeCode);
    }
    if (error.name === "NetworkError" || error.message.includes("network")) {
      return { code: "NETWORK_ERROR", message: "\u7F51\u7EDC\u8FDE\u63A5\u9519\u8BEF" };
    }
    if (error.message.includes("invalid") || error.message.includes("validation")) {
      return { code: "VALIDATION_ERROR", message: "\u8F93\u5165\u9A8C\u8BC1\u5931\u8D25" };
    }
    if (error.message.includes("permission") || error.message.includes("unauthorized")) {
      return { code: "PERMISSION_ERROR", message: "\u6743\u9650\u4E0D\u8DB3" };
    }
    if (error.message.includes("timeout") || error.message.includes("timed out")) {
      return { code: "TIMEOUT_ERROR", message: "\u64CD\u4F5C\u8D85\u65F6" };
    }
    return {
      code: "UNKNOWN_ERROR",
      message: "\u53D1\u751F\u4E86\u672A\u77E5\u9519\u8BEF"
    };
  }
  /**
   * 获取错误解决方案
   * @param code 错误代码
   * @returns 解决方案建议
   */
  static getSolution(code) {
    const solutions = /* @__PURE__ */ new Map([
      ["FILE_NOT_FOUND", "\u8BF7\u68C0\u67E5\u6587\u4EF6\u8DEF\u5F84\u662F\u5426\u6B63\u786E"],
      ["PERMISSION_DENIED", "\u8BF7\u68C0\u67E5\u6587\u4EF6\u6743\u9650\u6216\u4F7F\u7528\u7BA1\u7406\u5458\u6743\u9650\u8FD0\u884C"],
      ["NETWORK_ERROR", "\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5\u5E76\u91CD\u8BD5"],
      ["VALIDATION_ERROR", "\u8BF7\u68C0\u67E5\u8F93\u5165\u6570\u636E\u683C\u5F0F\u662F\u5426\u6B63\u786E"],
      ["TIMEOUT_ERROR", "\u8BF7\u589E\u52A0\u8D85\u65F6\u65F6\u95F4\u6216\u7A0D\u540E\u91CD\u8BD5"],
      ["CONNECTION_REFUSED", "\u8BF7\u68C0\u67E5\u670D\u52A1\u662F\u5426\u6B63\u5728\u8FD0\u884C"]
    ]);
    return solutions.get(code) || null;
  }
  /**
   * 脱敏调用栈
   * @param stack 调用栈字符串
   * @returns 脱敏后的调用栈
   */
  static sanitizeStack(stack) {
    const homeDir = __require("os").homedir();
    let sanitized = stack.replace(new RegExp(homeDir, "g"), "~");
    const projectRoot = process.cwd();
    sanitized = sanitized.replace(new RegExp(projectRoot, "g"), "[PROJECT]");
    sanitized = sanitized.replace(/node_modules\/([a-zA-Z0-9_\-@]+\/)+/g, "node_modules/");
    sanitized = sanitized.replace(/:\d+:\d+(\))?$/gm, "$1");
    return sanitized;
  }
  /**
   * 脱敏上下文对象
   * @param context 上下文对象
   * @returns 脱敏后的上下文
   */
  static sanitizeContext(context) {
    const sanitized = {};
    for (const [key, value] of Object.entries(context)) {
      if (this.isSensitiveKey(key)) {
        sanitized[key] = "[REDACTED]";
        continue;
      }
      if (typeof value === "string") {
        sanitized[key] = this.sanitizeError(value);
      } else if (value && typeof value === "object") {
        sanitized[key] = this.sanitizeContext(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
  /**
   * 检查键名是否敏感
   * @param key 键名
   * @returns 是否敏感
   */
  static isSensitiveKey(key) {
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /token/i,
      /key/i,
      /auth/i,
      /credential/i,
      /api/i,
      /bearer/i
    ];
    return sensitivePatterns.some((pattern) => pattern.test(key));
  }
  /**
   * 包装异步函数，提供统一的错误处理
   * @param fn 要包装的函数
   * @param options 选项
   * @returns 包装后的函数
   */
  static wrapAsyncFunction(fn, options = {}) {
    const { context = {}, rethrow = false } = options;
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        const safeError = this.createFriendlyError(error, {
          includeStack: process.env.NODE_ENV === "development",
          context
        });
        if (rethrow) {
          throw new Error(safeError.error);
        }
        return safeError;
      }
    };
  }
  /**
   * 记录错误（安全记录）
   * @param error 错误对象
   * @param logger 日志记录器
   */
  static logError(error, logger) {
    var _a;
    const safeError = this.createFriendlyError(error, {
      includeCode: true,
      includeStack: true
    });
    logger.error("Error occurred", {
      code: safeError.code,
      message: safeError.error,
      data: safeError.data
    });
    if (logger.warn && ((_a = safeError.data) == null ? void 0 : _a.code) && ["TIMEOUT", "NETWORK"].includes(safeError.data.code)) {
      logger.warn("Recoverable error", {
        code: safeError.code,
        message: safeError.error
      });
    }
  }
};
var errorHandler = new ErrorHandler();

// packages/core/src/error/BladeError.ts
var BladeError = class _BladeError extends Error {
  module;
  code;
  severity;
  category;
  context;
  timestamp;
  retryable;
  recoverable;
  suggestions;
  relatedErrors;
  cause;
  constructor(module, code, message, details = {}) {
    super(message);
    this.name = "BladeError";
    this.module = module;
    this.code = code;
    this.severity = details.severity || "ERROR" /* ERROR */;
    this.category = details.category || "SYSTEM" /* SYSTEM */;
    this.context = details.context || {};
    this.timestamp = details.timestamp || Date.now();
    this.retryable = details.retryable || false;
    this.recoverable = details.recoverable || false;
    this.suggestions = details.suggestions || [];
    this.relatedErrors = [];
    if (details.cause) {
      this.cause = details.cause;
    }
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, _BladeError);
    }
  }
  /**
   * 检查错误是否可重试
   */
  isRetryable() {
    return this.retryable;
  }
  /**
   * 检查错误是否可恢复
   */
  isRecoverable() {
    return this.recoverable;
  }
  /**
   * 获取人类可读的错误消息
   */
  getHumanReadableMessage() {
    const baseMessage = this.message;
    if (this.suggestions.length > 0) {
      return `${baseMessage}
\u5EFA\u8BAE: ${this.suggestions.join(", ")}`;
    }
    return baseMessage;
  }
  /**
   * 从普通 Error 创建 BladeError
   */
  static from(error, module = "CORE" /* CORE */, defaultMessage = "\u672A\u77E5\u9519\u8BEF") {
    if (error instanceof _BladeError) {
      return error;
    }
    return new _BladeError(module, "UNKNOWN_ERROR", error.message || defaultMessage, {
      severity: "ERROR" /* ERROR */,
      category: "SYSTEM" /* SYSTEM */,
      context: { originalError: error.name, originalStack: error.stack }
    });
  }
  /**
   * 配置相关错误工厂方法
   */
  static config(code, message, details) {
    return new _BladeError(
      "CONFIG" /* CONFIG */,
      code,
      message,
      {
        ...details,
        category: "CONFIGURATION" /* CONFIGURATION */
      }
    );
  }
  /**
   * LLM 相关错误工厂方法
   */
  static llm(code, message, details) {
    return new _BladeError(
      "LLM" /* LLM */,
      code,
      message,
      {
        ...details,
        category: "LLM" /* LLM */
      }
    );
  }
  /**
   * MCP 相关错误工厂方法
   */
  static mcp(code, message, details) {
    return new _BladeError(
      "MCP" /* MCP */,
      code,
      message,
      {
        ...details,
        category: "API" /* API */
      }
    );
  }
  /**
   * Agent 相关错误工厂方法
   */
  static agent(code, message, details) {
    return new _BladeError(
      "TOOLS" /* TOOLS */,
      code,
      message,
      {
        ...details,
        category: "BUSINESS" /* BUSINESS */
      }
    );
  }
  /**
   * 工具相关错误工厂方法
   */
  static tools(code, message, details) {
    return new _BladeError(
      "TOOLS" /* TOOLS */,
      code,
      message,
      {
        ...details,
        category: "API" /* API */
      }
    );
  }
  /**
   * 序列化为 JSON
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      module: this.module,
      severity: this.severity,
      category: this.category,
      context: this.context,
      stack: this.stack,
      timestamp: this.timestamp,
      retryable: this.retryable,
      recoverable: this.recoverable,
      suggestions: this.suggestions
    };
  }
  /**
   * 转换为字符串
   */
  toString() {
    return `${this.name} [${this.module}:${this.code}]: ${this.message}`;
  }
};
var ConfigError = class extends BladeError {
  constructor(code, message, details) {
    super("CONFIG" /* CONFIG */, code, message, {
      ...details,
      category: "CONFIGURATION" /* CONFIGURATION */
    });
    this.name = "ConfigError";
  }
};
var LLMError = class extends BladeError {
  constructor(code, message, details) {
    super("LLM" /* LLM */, code, message, {
      ...details,
      category: "LLM" /* LLM */
    });
    this.name = "LLMError";
  }
};
var MCPError = class extends BladeError {
  constructor(code, message, details) {
    super("MCP" /* MCP */, code, message, {
      ...details,
      category: "API" /* API */
    });
    this.name = "MCPError";
  }
};
var AgentError = class extends BladeError {
  constructor(code, message, details) {
    super("TOOLS" /* TOOLS */, code, message, {
      ...details,
      category: "BUSINESS" /* BUSINESS */
    });
    this.name = "AgentError";
  }
};
var ToolsError = class extends BladeError {
  constructor(code, message, details) {
    super("TOOLS" /* TOOLS */, code, message, {
      ...details,
      category: "API" /* API */
    });
    this.name = "ToolsError";
  }
};
var FileSystemError = class extends BladeError {
  constructor(code, message, details) {
    super("FILE_SYSTEM" /* FILE_SYSTEM */, code, message, {
      ...details,
      category: "FILE_SYSTEM" /* FILE_SYSTEM */
    });
    this.name = "FileSystemError";
  }
};
var NetworkError = class extends BladeError {
  constructor(code, message, details) {
    super("NETWORK" /* NETWORK */, code, message, {
      ...details,
      category: "NETWORK" /* NETWORK */
    });
    this.name = "NetworkError";
  }
};
var SecurityError = class extends BladeError {
  constructor(code, message, details) {
    super("SECURITY" /* SECURITY */, code, message, {
      ...details,
      category: "SECURITY" /* SECURITY */
    });
    this.name = "SecurityError";
  }
};

// packages/core/src/error/RetryManager.ts
var RetryManager = class {
  retryConfig;
  circuitBreakerConfig;
  retryStates = /* @__PURE__ */ new Map();
  circuitStates = /* @__PURE__ */ new Map();
  constructor(config = {}, circuitBreakerConfig) {
    this.retryConfig = {
      maxAttempts: 3,
      initialDelay: 1e3,
      maxDelay: 3e4,
      backoffFactor: 2,
      jitter: true,
      retryableErrors: [],
      ...config
    };
    this.circuitBreakerConfig = circuitBreakerConfig;
  }
  /**
   * 执行带有重试的异步操作
   */
  async execute(operation, operationId) {
    const id = operationId || this.generateOperationId();
    const retryState = this.getOrCreateRetryState(id);
    if (this.circuitBreakerConfig) {
      const circuitState = this.getCircuitState(id);
      if (circuitState.state === "OPEN" /* OPEN */) {
        throw new BladeError(
          "CORE" /* CORE */,
          "0004",
          `\u64CD\u4F5C "${id}" \u88AB\u7194\u65AD\u5668\u62D2\u7EDD`,
          {
            category: "NETWORK",
            retryable: false,
            context: { circuitState: circuitState.state }
          }
        );
      }
    }
    while (retryState.attempts < this.retryConfig.maxAttempts) {
      try {
        const result = await operation();
        this.resetState(id);
        return result;
      } catch (error) {
        const bladeError = error instanceof BladeError ? error : BladeError.from(error);
        retryState.errors.push(bladeError);
        retryState.attempts++;
        retryState.lastAttempt = Date.now();
        if (!this.shouldRetry(bladeError, retryState.attempts)) {
          this.updateCircuitState(id, false);
          throw bladeError;
        }
        retryState.nextDelay = this.calculateDelay(retryState.attempts);
        console.warn(`\u91CD\u8BD5\u64CD\u4F5C "${id}" (\u5C1D\u8BD5 ${retryState.attempts}/${this.retryConfig.maxAttempts})\uFF0C\u5EF6\u8FDF ${retryState.nextDelay}ms`);
        await this.delay(retryState.nextDelay);
      }
    }
    this.updateCircuitState(id, false);
    throw retryState.errors[retryState.errors.length - 1];
  }
  /**
   * 执行带有重试和超时的异步操作
   */
  async executeWithTimeout(operation, timeoutMs, operationId) {
    const id = operationId || this.generateOperationId();
    return Promise.race([
      this.execute(operation, id),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new BladeError(
            "CORE" /* CORE */,
            "0004",
            `\u64CD\u4F5C "${id}" \u8D85\u65F6`,
            {
              category: "TIMEOUT",
              retryable: true,
              context: { timeout: timeoutMs }
            }
          ));
        }, timeoutMs);
      })
    ]);
  }
  /**
   * 获取重试状态
   */
  getRetryState(operationId) {
    return this.retryStates.get(operationId);
  }
  /**
   * 重置状态
   */
  resetState(operationId) {
    this.retryStates.delete(operationId);
    this.updateCircuitState(operationId, true);
  }
  /**
   * 清理过期的状态
   */
  cleanup() {
    const now = Date.now();
    const maxAge = this.retryConfig.maxDelay * 10;
    for (const [id, state] of this.retryStates.entries()) {
      if (now - state.lastAttempt > maxAge) {
        this.retryStates.delete(id);
      }
    }
    if (this.circuitBreakerConfig) {
      for (const [, circuitState] of this.circuitStates.entries()) {
        if (circuitState.state === "OPEN" /* OPEN */ && now - circuitState.lastFailure > this.circuitBreakerConfig.recoveryTimeout) {
          circuitState.state = "HALF_OPEN" /* HALF_OPEN */;
        }
      }
    }
  }
  /**
   * 获取或创建重试状态
   */
  getOrCreateRetryState(operationId) {
    if (!this.retryStates.has(operationId)) {
      const state = {
        attempts: 0,
        lastAttempt: 0,
        nextDelay: 0,
        errors: []
      };
      this.retryStates.set(operationId, state);
    }
    return this.retryStates.get(operationId);
  }
  /**
   * 判断是否应该重试
   */
  shouldRetry(error, attempts) {
    if (attempts >= this.retryConfig.maxAttempts) {
      return false;
    }
    if (this.retryConfig.retryableErrors.length > 0) {
      return this.retryConfig.retryableErrors.includes(error.code);
    }
    return error.isRetryable();
  }
  /**
   * 计算退避延迟
   */
  calculateDelay(attempts) {
    let delay = this.retryConfig.initialDelay * Math.pow(this.retryConfig.backoffFactor, attempts - 1);
    delay = Math.min(delay, this.retryConfig.maxDelay);
    if (this.retryConfig.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }
    return Math.floor(delay);
  }
  /**
   * 延迟函数
   */
  delay(ms) {
    return new Promise((resolve5) => setTimeout(resolve5, ms));
  }
  /**
   * 生成操作ID
   */
  generateOperationId() {
    return `retry_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  /**
   * 获取熔断器状态
   */
  getCircuitState(operationId) {
    if (!this.circuitBreakerConfig) {
      return { state: "CLOSED" /* CLOSED */, failures: 0, lastFailure: 0 };
    }
    if (!this.circuitStates.has(operationId)) {
      this.circuitStates.set(operationId, {
        state: "CLOSED" /* CLOSED */,
        failures: 0,
        lastFailure: 0
      });
    }
    return this.circuitStates.get(operationId);
  }
  /**
   * 更新熔断器状态
   */
  updateCircuitState(operationId, success) {
    if (!this.circuitBreakerConfig) {
      return;
    }
    const circuitState = this.getCircuitState(operationId);
    if (success) {
      circuitState.state = "CLOSED" /* CLOSED */;
      circuitState.failures = 0;
    } else {
      circuitState.failures++;
      circuitState.lastFailure = Date.now();
      if (circuitState.failures >= this.circuitBreakerConfig.failureThreshold) {
        circuitState.state = "OPEN" /* OPEN */;
      }
    }
  }
};
var globalRetryManager = new RetryManager();

// packages/core/src/error/RecoveryManager.ts
var RecoveryManager = class {
  strategies = /* @__PURE__ */ new Map();
  defaultMaxAttempts = 3;
  recoveryTimeout = 1e4;
  // 10秒恢复超时
  constructor(options) {
    if (options) {
      this.defaultMaxAttempts = options.maxAttempts || this.defaultMaxAttempts;
      this.recoveryTimeout = options.recoveryTimeout || this.recoveryTimeout;
    }
    this.initializeDefaultStrategies();
  }
  /**
   * 注册恢复策略
   */
  registerStrategy(strategy) {
    this.strategies.set(strategy.name, strategy);
  }
  /**
   * 取消注册恢复策略
   */
  unregisterStrategy(name) {
    this.strategies.delete(name);
  }
  /**
   * 尝试恢复错误
   */
  async recover(error, operationId, context) {
    const startTime = Date.now();
    let attempts = 0;
    const applicableStrategies = Array.from(this.strategies.values()).filter(
      (strategy) => strategy.condition(error)
    );
    if (applicableStrategies.length === 0) {
      return {
        success: false,
        recovered: false,
        message: "\u6CA1\u6709\u627E\u5230\u9002\u7528\u7684\u6062\u590D\u7B56\u7565",
        context: {
          error,
          attempts,
          maxAttempts: 0,
          operationId: operationId || "unknown",
          startTime,
          additionalContext: context
        }
      };
    }
    for (const strategy of applicableStrategies) {
      attempts++;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`\u6062\u590D\u7B56\u7565 "${strategy.name}" \u8D85\u65F6`));
          }, this.recoveryTimeout);
        });
        const recoveryPromise = strategy.action(error);
        const success = await Promise.race([recoveryPromise, timeoutPromise]);
        if (success) {
          return {
            success: true,
            recovered: true,
            message: `\u4F7F\u7528\u7B56\u7565 "${strategy.name}" \u6210\u529F\u6062\u590D`,
            action: strategy.name,
            nextStep: "\u7EE7\u7EED\u6267\u884C",
            context: {
              error,
              attempts,
              maxAttempts: strategy.maxAttempts,
              operationId: operationId || "unknown",
              startTime,
              additionalContext: context
            }
          };
        }
      } catch (recoveryError) {
        console.warn(`\u6062\u590D\u7B56\u7565 "${strategy.name}" \u6267\u884C\u5931\u8D25:`, recoveryError);
        if (attempts >= applicableStrategies.length) {
          break;
        }
        await new Promise((resolve5) => setTimeout(resolve5, 100));
      }
    }
    return {
      success: false,
      recovered: false,
      message: "\u6240\u6709\u6062\u590D\u7B56\u7565\u90FD\u5931\u8D25\u4E86",
      context: {
        error,
        attempts,
        maxAttempts: applicableStrategies.reduce((sum, s) => sum + s.maxAttempts, 0),
        operationId: operationId || "unknown",
        startTime,
        additionalContext: context
      }
    };
  }
  /**
   * 执行带有恢复能力的操作
   */
  async executeWithRecovery(operation, operationId, context) {
    try {
      return await operation();
    } catch (error) {
      const bladeError = error instanceof BladeError ? error : BladeError.from(error);
      const recoveryResult = await this.recover(bladeError, operationId, context);
      if (recoveryResult.success && recoveryResult.recovered) {
        console.info(`\u9519\u8BEF\u6062\u590D\u6210\u529F: ${recoveryResult.message}`);
        if (recoveryResult.nextStep === "\u7EE7\u7EED\u6267\u884C") {
          return await operation();
        }
      }
      throw new BladeError(
        "CORE" /* CORE */,
        "0004",
        `\u9519\u8BEF\u65E0\u6CD5\u6062\u590D: ${recoveryResult.message}`,
        {
          category: bladeError.category,
          retryable: false,
          context: {
            originalError: bladeError,
            recoveryResult
          }
        }
      );
    }
  }
  /**
   * 获取恢复策略统计
   */
  getStatistics() {
    return {};
  }
  /**
   * 初始化默认恢复策略
   */
  initializeDefaultStrategies() {
    this.registerStrategy({
      name: "network-reconnect",
      condition: (error) => error.category === "NETWORK",
      action: async (error) => {
        await new Promise((resolve5) => setTimeout(resolve5, 1e3));
        return true;
      },
      maxAttempts: 3
    });
    this.registerStrategy({
      name: "config-reload",
      condition: (error) => error.category === "CONFIGURATION",
      action: async (error) => {
        await new Promise((resolve5) => setTimeout(resolve5, 500));
        return true;
      },
      maxAttempts: 2
    });
    this.registerStrategy({
      name: "cache-clear",
      condition: (error) => error.code.includes("CONTEXT"),
      action: async (error) => {
        await new Promise((resolve5) => setTimeout(resolve5, 300));
        return true;
      },
      maxAttempts: 1
    });
    this.registerStrategy({
      name: "memory-optimize",
      condition: (error) => error.category === "MEMORY",
      action: async (error) => {
        global.gc && global.gc();
        await new Promise((resolve5) => setTimeout(resolve5, 1e3));
        return true;
      },
      maxAttempts: 2
    });
    this.registerStrategy({
      name: "permission-retry",
      condition: (error) => error.code.includes("PERMISSION"),
      action: async (error) => {
        await new Promise((resolve5) => setTimeout(resolve5, 2e3));
        return false;
      },
      maxAttempts: 1
    });
  }
};
var globalRecoveryManager = new RecoveryManager();

// packages/core/src/error/ErrorMonitor.ts
var ErrorMonitor = class {
  config;
  errorCounts = /* @__PURE__ */ new Map();
  errorReports = [];
  statistics;
  errorStream = null;
  constructor(config = {}) {
    this.config = {
      enabled: true,
      sampleRate: 1,
      maxErrorsPerMinute: 100,
      excludePatterns: [],
      includePatterns: [],
      autoReport: false,
      storeReports: true,
      maxStoredReports: 1e3,
      enableConsole: true,
      enableFile: false,
      ...config
    };
    this.statistics = this.initializeStatistics();
    this.setupErrorCollection();
  }
  /**
   * 监控错误
   */
  async monitor(error) {
    if (!this.config.enabled) {
      return;
    }
    const bladeError = error instanceof BladeError ? error : BladeError.from(error);
    if (Math.random() > this.config.sampleRate) {
      return;
    }
    if (this.shouldExcludeError(bladeError)) {
      return;
    }
    if (this.isErrorRateExceeded()) {
      return;
    }
    this.updateStatistics(bladeError);
    const report = this.createErrorReport(bladeError);
    if (this.config.storeReports) {
      this.storeReport(report);
    }
    if (this.config.enableConsole) {
      this.logToConsole(bladeError, report);
    }
    if (this.config.enableFile && this.config.logFilePath) {
      await this.logToFile(bladeError, report);
    }
    if (this.config.autoReport && this.config.reportEndpoint) {
      await this.reportToEndpoint(report);
    }
  }
  /**
   * 创建错误流
   */
  createErrorStream() {
    const errors = [];
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (errors.length === 0) {
              return { value: void 0, done: true };
            }
            const error = errors.shift();
            return { value: error, done: false };
          }
        };
      }
    };
  }
  /**
   * 获取错误统计
   */
  getStatistics() {
    return { ...this.statistics };
  }
  /**
   * 获取错误报告
   */
  getErrorReports(limit) {
    const reports = [...this.errorReports];
    return limit ? reports.slice(-limit) : reports;
  }
  /**
   * 清理旧的错误报告
   */
  cleanup() {
    if (this.errorReports.length > this.config.maxStoredReports) {
      this.errorReports = this.errorReports.slice(-this.config.maxStoredReports);
    }
  }
  /**
   * 设置报警规则
   */
  setAlertRule(_config) {
    console.warn("\u62A5\u8B66\u89C4\u5219\u8BBE\u7F6E\u529F\u80FD\u5F85\u5B9E\u73B0");
  }
  /**
   * 导出错误数据
   */
  exportData(format = "json") {
    if (format === "json") {
      return JSON.stringify({
        statistics: this.statistics,
        reports: this.errorReports,
        timestamp: Date.now()
      }, null, 2);
    } else if (format === "csv") {
      const headers = ["timestamp", "code", "message", "category", "module"];
      const rows = this.errorReports.map((report) => [
        report.timestamp,
        report.error.code,
        report.error.message,
        report.error.category,
        report.error.module
      ]);
      return [headers, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");
    }
    throw new Error("\u4E0D\u652F\u6301\u7684\u5BFC\u51FA\u683C\u5F0F");
  }
  /**
   * 初始化统计数据
   */
  initializeStatistics() {
    return {
      totalErrors: 0,
      errorsByCategory: {},
      errorsByModule: {},
      errorsByCode: {},
      retryableErrors: 0,
      unrecoverableErrors: 0,
      averageRecoveryTime: 0,
      lastErrorTime: 0
    };
  }
  /**
   * 设置错误收集
   */
  setupErrorCollection() {
    process.on("uncaughtException", async (error) => {
      await this.monitor(error);
    });
    process.on("unhandledRejection", async (reason) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      await this.monitor(error);
    });
  }
  /**
   * 检查是否应该排除错误
   */
  shouldExcludeError(error) {
    if (this.config.excludePatterns.length > 0) {
      const errorMessage = error.message.toLowerCase();
      const errorCode = error.code.toLowerCase();
      for (const pattern of this.config.excludePatterns) {
        const lowerPattern = pattern.toLowerCase();
        if (errorMessage.includes(lowerPattern) || errorCode.includes(lowerPattern)) {
          return true;
        }
      }
    }
    if (this.config.includePatterns.length > 0) {
      const errorMessage = error.message.toLowerCase();
      const errorCode = error.code.toLowerCase();
      for (const pattern of this.config.includePatterns) {
        const lowerPattern = pattern.toLowerCase();
        if (errorMessage.includes(lowerPattern) || errorCode.includes(lowerPattern)) {
          return false;
        }
      }
      return true;
    }
    return false;
  }
  /**
   * 检查错误频率是否超过限制
   */
  isErrorRateExceeded() {
    const now = Date.now();
    const oneMinuteAgo = now - 6e4;
    let recentErrors = 0;
    for (const report of this.errorReports) {
      if (report.timestamp > oneMinuteAgo) {
        recentErrors++;
      }
    }
    return recentErrors >= this.config.maxErrorsPerMinute;
  }
  /**
   * 更新统计信息
   */
  updateStatistics(error) {
    this.statistics.totalErrors++;
    this.statistics.lastErrorTime = Date.now();
    this.statistics.errorsByCategory[error.category] = (this.statistics.errorsByCategory[error.category] || 0) + 1;
    this.statistics.errorsByModule[error.module] = (this.statistics.errorsByModule[error.module] || 0) + 1;
    this.statistics.errorsByCode[error.code] = (this.statistics.errorsByCode[error.code] || 0) + 1;
    if (error.isRetryable()) {
      this.statistics.retryableErrors++;
    } else {
      this.statistics.unrecoverableErrors++;
    }
  }
  /**
   * 创建错误报告
   */
  createErrorReport(error) {
    var _a;
    return {
      id: this.generateReportId(),
      timestamp: Date.now(),
      error,
      userAgent: process.env.USER_AGENT || "unknown",
      os: process.platform,
      version: process.env.npm_package_version || "unknown",
      sessionId: process.env.SESSION_ID || this.generateSessionId(),
      traceId: ((_a = error.context) == null ? void 0 : _a.traceId) || this.generateTraceId()
    };
  }
  /**
   * 存储错误报告
   */
  storeReport(report) {
    this.errorReports.push(report);
    if (this.errorReports.length > this.config.maxStoredReports) {
      this.errorReports.shift();
    }
  }
  /**
   * 输出到控制台
   */
  logToConsole(error, report) {
    const timestamp = new Date(report.timestamp).toISOString();
    console.error(`[${timestamp}] ${error.toString()}`);
    if (error.context) {
      console.error("\u4E0A\u4E0B\u6587\u4FE1\u606F:", JSON.stringify(error.context, null, 2));
    }
    if (error.suggestions.length > 0) {
      console.error("\u5EFA\u8BAE\u89E3\u51B3\u65B9\u6848:", error.suggestions);
    }
  }
  /**
   * 输出到文件
   */
  async logToFile(error, _report) {
    console.log(`[\u6587\u4EF6\u65E5\u5FD7] ${error.toString()}`);
  }
  /**
   * 上报到端点
   */
  async reportToEndpoint(report) {
    if (!this.config.reportEndpoint) {
      return;
    }
    try {
      const response = await fetch(this.config.reportEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(report)
      });
      if (!response.ok) {
        console.warn(`\u9519\u8BEF\u4E0A\u62A5\u5931\u8D25: ${response.status} ${response.statusText}`);
      }
    } catch (uploadError) {
      console.warn("\u9519\u8BEF\u4E0A\u62A5\u5931\u8D25:", uploadError);
    }
  }
  /**
   * 生成报告ID
   */
  generateReportId() {
    return `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  /**
   * 生成会话ID
   */
  generateSessionId() {
    return `session_${Math.random().toString(36).substr(2, 16)}`;
  }
  /**
   * 生成跟踪ID
   */
  generateTraceId() {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 12)}`;
  }
};
var globalErrorMonitor = new ErrorMonitor();

// packages/core/src/error/ErrorFactory.ts
var ErrorFactory = class {
  /**
   * 创建通用错误
   */
  static createError(message, config = {}) {
    const module = config.module || "CORE" /* CORE */;
    return new BladeError(module, "INTERNAL_ERROR", message, {
      severity: config.severity || "ERROR" /* ERROR */,
      retryable: config.retryable ?? false,
      recoverable: config.recoverable ?? false,
      context: config.context || {},
      suggestions: config.suggestions || [],
      cause: config.cause
    });
  }
  /**
   * 创建配置错误
   */
  static createConfigError(errorCode, message, config = {}) {
    return new ConfigError(errorCode, message, {
      ...config,
      severity: config.severity || "WARNING" /* WARNING */
    });
  }
  /**
   * 创建LLM错误
   */
  static createLLMError(errorCode, message, config = {}) {
    return new LLMError(errorCode, message, {
      ...config,
      severity: config.severity || "ERROR" /* ERROR */,
      retryable: config.retryable ?? true
    });
  }
  /**
   * 创建MCP错误
   */
  static createMCPError(errorCode, message, config = {}) {
    return new MCPError(errorCode, message, {
      ...config,
      severity: config.severity || "WARNING" /* WARNING */,
      retryable: config.retryable ?? true
    });
  }
  /**
   * 创建代理错误
   */
  static createAgentError(errorCode, message, config = {}) {
    return new AgentError(errorCode, message, {
      ...config,
      severity: config.severity || "ERROR" /* ERROR */,
      retryable: config.retryable ?? false
    });
  }
  /**
   * 创建工具错误
   */
  static createToolsError(errorCode, message, config = {}) {
    return new ToolsError(errorCode, message, {
      ...config,
      severity: config.severity || "CRITICAL" /* CRITICAL */,
      retryable: false
    });
  }
  /**
   * 从原生Error创建BladeError
   */
  static fromNativeError(error, defaultMessage = "\u672A\u77E5\u9519\u8BEF", config = {}) {
    return BladeError.from(error, config.module, defaultMessage);
  }
  /**
   * 创建HTTP相关错误
   */
  static createHttpError(status, url, responseText, config = {}) {
    let errorCode = "REQUEST_FAILED";
    let message;
    let suggestions = [];
    switch (status) {
      case 400:
        errorCode = "REQUEST_FAILED";
        message = `HTTP 400 \u9519\u8BEF\u8BF7\u6C42: ${url}`;
        suggestions = ["\u68C0\u67E5\u8BF7\u6C42\u53C2\u6570", "\u9A8C\u8BC1\u8BF7\u6C42\u6570\u636E\u683C\u5F0F"];
        break;
      case 401:
        errorCode = "REQUEST_FAILED";
        message = `HTTP 401 \u672A\u6388\u6743: ${url}`;
        suggestions = ["\u68C0\u67E5API\u5BC6\u94A5", "\u9A8C\u8BC1\u8EAB\u4EFD\u4FE1\u606F"];
        break;
      case 403:
        errorCode = "REQUEST_FAILED";
        message = `HTTP 403 \u7981\u6B62\u8BBF\u95EE: ${url}`;
        suggestions = ["\u68C0\u67E5\u8BBF\u95EE\u6743\u9650", "\u8054\u7CFB\u7BA1\u7406\u5458"];
        break;
      case 404:
        errorCode = "REQUEST_FAILED";
        message = `HTTP 404 \u672A\u627E\u5230: ${url}`;
        suggestions = ["\u68C0\u67E5URL\u662F\u5426\u6B63\u786E", "\u786E\u8BA4\u8D44\u6E90\u662F\u5426\u5B58\u5728"];
        break;
      case 429:
        errorCode = "REQUEST_FAILED";
        message = `HTTP 429 \u8BF7\u6C42\u8FC7\u591A: ${url}`;
        suggestions = ["\u51CF\u5C11\u8BF7\u6C42\u9891\u7387", "\u5B9E\u73B0\u8BF7\u6C42\u9650\u6D41"];
        break;
      case 500:
        errorCode = "REQUEST_FAILED";
        message = `HTTP 500 \u670D\u52A1\u5668\u9519\u8BEF: ${url}`;
        suggestions = ["\u7A0D\u540E\u91CD\u8BD5", "\u8054\u7CFB\u670D\u52A1\u63D0\u4F9B\u5546"];
        break;
      case 502:
        errorCode = "MCP_UNAVAILABLE";
        message = `HTTP 502 \u7F51\u5173\u9519\u8BEF: ${url}`;
        suggestions = ["\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5", "\u7A0D\u540E\u91CD\u8BD5"];
        break;
      case 503:
        errorCode = "MCP_UNAVAILABLE";
        message = `HTTP 503 \u670D\u52A1\u4E0D\u53EF\u7528: ${url}`;
        suggestions = ["\u7A0D\u540E\u91CD\u8BD5", "\u68C0\u67E5\u670D\u52A1\u72B6\u6001"];
        break;
      case 504:
        errorCode = "TIMEOUT_EXCEEDED";
        message = `HTTP 504 \u7F51\u5173\u8D85\u65F6: ${url}`;
        suggestions = ["\u589E\u52A0\u8D85\u65F6\u65F6\u95F4", "\u68C0\u67E5\u7F51\u7EDC\u5EF6\u8FDF"];
        break;
      default:
        message = `HTTP ${status} \u9519\u8BEF: ${url}`;
        suggestions = ["\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5", "\u7A0D\u540E\u91CD\u8BD5"];
    }
    return this.createMCPError(errorCode, message, {
      ...config,
      context: {
        ...config.context,
        status,
        url,
        responseText
      },
      suggestions: [...config.suggestions || [], ...suggestions]
    });
  }
  /**
   * 创建超时错误
   */
  static createTimeoutError(operation, timeoutMs, config = {}) {
    return this.createMCPError("TIMEOUT_EXCEEDED", `\u64CD\u4F5C "${operation}" \u8D85\u65F6`, {
      ...config,
      context: {
        ...config.context,
        operation,
        timeout: timeoutMs
      },
      suggestions: ["\u589E\u52A0\u8D85\u65F6\u65F6\u95F4\u914D\u7F6E", "\u68C0\u67E5\u7F51\u7EDC\u6027\u80FD", "\u4F18\u5316\u64CD\u4F5C\u903B\u8F91"]
    });
  }
  /**
   * 创建验证错误
   */
  static createValidationError(fieldName, fieldValue, expectedType, config = {}) {
    return this.createConfigError("CONFIG_VALIDATION_FAILED", `\u5B57\u6BB5 "${fieldName}" \u9A8C\u8BC1\u5931\u8D25`, {
      ...config,
      severity: "WARNING" /* WARNING */,
      context: {
        ...config.context,
        fieldName,
        fieldValue,
        expectedType
      },
      suggestions: [
        `\u68C0\u67E5\u5B57\u6BB5 "${fieldName}" \u7684\u7C7B\u578B`,
        `\u63D0\u4F9B\u7B26\u5408 ${expectedType} \u7C7B\u578B\u7684\u503C`,
        "\u67E5\u770B\u914D\u7F6E\u6587\u6863"
      ]
    });
  }
  /**
   * 创建未找到错误
   */
  static createNotFoundError(resource, identifier, config = {}) {
    let errorCode = "INTERNAL_ERROR";
    let module = "CORE" /* CORE */;
    if (resource.toLowerCase().includes("file")) {
      errorCode = "FILE_NOT_FOUND";
      module = "TOOLS" /* TOOLS */;
    } else if (resource.toLowerCase().includes("config")) {
      errorCode = "CONFIG_NOT_FOUND";
      module = "CONFIG" /* CONFIG */;
    } else if (resource.toLowerCase().includes("tool")) {
      errorCode = "TOOL_NOT_FOUND";
      module = "TOOLS" /* TOOLS */;
    }
    return new BladeError(module, errorCode, `${resource} "${identifier}" \u672A\u627E\u5230`, {
      ...config,
      context: {
        ...config.context,
        resource,
        identifier
      },
      suggestions: [`\u68C0\u67E5 ${resource} \u8DEF\u5F84\u662F\u5426\u6B63\u786E`, `\u786E\u8BA4 ${resource} \u662F\u5426\u5B58\u5728`, "\u68C0\u67E5\u6743\u9650\u8BBE\u7F6E"]
    });
  }
  /**
   * 创建权限错误
   */
  static createPermissionError(operation, resource, config = {}) {
    let errorCode = "PERMISSION_DENIED";
    let module = "TOOLS" /* TOOLS */;
    if (resource.toLowerCase().includes("security")) {
      errorCode = "AUTHORIZATION_FAILED";
      module = "TOOLS" /* TOOLS */;
    } else if (resource.toLowerCase().includes("tool")) {
      errorCode = "TOOL_PERMISSION_DENIED";
      module = "TOOLS" /* TOOLS */;
    }
    return new BladeError(module, errorCode, `\u6CA1\u6709\u6743\u9650\u6267\u884C "${operation}" \u64CD\u4F5C`, {
      ...config,
      severity: "WARNING" /* WARNING */,
      context: {
        ...config.context,
        operation,
        resource
      },
      suggestions: [`\u68C0\u67E5\u5BF9 ${resource} \u7684\u8BBF\u95EE\u6743\u9650`, "\u8054\u7CFB\u7BA1\u7406\u5458\u83B7\u53D6\u6743\u9650", "\u4F7F\u7528\u9002\u5F53\u7684\u8EAB\u4EFD\u9A8C\u8BC1"]
    });
  }
  /**
   * 创建内存错误
   */
  static createMemoryError(operation, memoryInfo, config = {}) {
    return this.createError(`\u5185\u5B58\u4E0D\u8DB3: "${operation}"`, {
      ...config,
      module: "CORE" /* CORE */,
      category: "MEMORY" /* MEMORY */,
      severity: "ERROR" /* ERROR */,
      context: {
        ...config.context,
        operation,
        memoryInfo
      },
      suggestions: ["\u91CA\u653E\u4E0D\u5FC5\u8981\u7684\u5185\u5B58", "\u589E\u52A0\u7CFB\u7EDF\u5185\u5B58", "\u4F18\u5316\u5185\u5B58\u4F7F\u7528", "\u68C0\u67E5\u5185\u5B58\u6CC4\u6F0F"]
    });
  }
  /**
   * 创建初始化错误
   */
  static createInitializationError(component, cause, config = {}) {
    return new BladeError(
      "CORE" /* CORE */,
      "INITIALIZATION_FAILED",
      `\u7EC4\u4EF6 "${component}" \u521D\u59CB\u5316\u5931\u8D25`,
      {
        ...config,
        severity: "CRITICAL" /* CRITICAL */,
        context: {
          ...config.context,
          component
        },
        cause: cause instanceof BladeError ? cause : cause ? BladeError.from(cause) : void 0,
        suggestions: ["\u68C0\u67E5\u7EC4\u4EF6\u914D\u7F6E", "\u9A8C\u8BC1\u4F9D\u8D56\u5173\u7CFB", "\u67E5\u770B\u65E5\u5FD7\u83B7\u53D6\u8BE6\u7EC6\u4FE1\u606F"]
      }
    );
  }
  /**
   * 创建文件系统错误
   */
  static createFileSystemError(errorCode, message, config = {}) {
    return new FileSystemError(errorCode, message, {
      severity: config.severity || "ERROR" /* ERROR */,
      retryable: config.retryable ?? true,
      recoverable: config.recoverable ?? true,
      context: config.context || {},
      suggestions: config.suggestions || [
        "\u68C0\u67E5\u6587\u4EF6\u8DEF\u5F84\u662F\u5426\u6B63\u786E",
        "\u9A8C\u8BC1\u6587\u4EF6\u6743\u9650",
        "\u786E\u8BA4\u78C1\u76D8\u7A7A\u95F4\u5145\u8DB3"
      ],
      cause: config.cause ? config.cause instanceof BladeError ? config.cause : BladeError.from(config.cause) : void 0,
      ...config
    });
  }
  /**
   * 创建网络错误
   */
  static createNetworkError(errorCode, message, config = {}) {
    return new NetworkError(errorCode, message, {
      severity: config.severity || "ERROR" /* ERROR */,
      retryable: config.retryable ?? true,
      recoverable: config.recoverable ?? true,
      context: config.context || {},
      suggestions: config.suggestions || ["\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5", "\u9A8C\u8BC1URL\u662F\u5426\u6B63\u786E", "\u7A0D\u540E\u91CD\u8BD5"],
      cause: config.cause ? config.cause instanceof BladeError ? config.cause : BladeError.from(config.cause) : void 0,
      ...config
    });
  }
  /**
   * 创建安全错误
   */
  static createSecurityError(errorCode, message, config = {}) {
    return new SecurityError(errorCode, message, {
      severity: config.severity || "CRITICAL" /* CRITICAL */,
      retryable: config.retryable ?? false,
      recoverable: config.recoverable ?? false,
      context: config.context || {},
      suggestions: config.suggestions || ["\u68C0\u67E5\u8BA4\u8BC1\u4FE1\u606F", "\u9A8C\u8BC1\u6743\u9650\u8BBE\u7F6E", "\u8054\u7CFB\u7BA1\u7406\u5458"],
      cause: config.cause ? config.cause instanceof BladeError ? config.cause : BladeError.from(config.cause) : void 0,
      ...config
    });
  }
};

// packages/core/src/error/ErrorSerializer.ts
var ErrorSerializer = class {
  config;
  constructor(config = {}) {
    this.config = {
      includeStack: true,
      includeContext: true,
      includeCause: true,
      includeRelatedErrors: true,
      maxContextDepth: 10,
      stripSensitiveData: true,
      sensitiveFields: ["password", "token", "apiKey", "secret", "creditCard"],
      ...config
    };
  }
  /**
   * 序列化单个错误
   */
  serialize(error) {
    let serialized = {
      name: error.name,
      message: error.message,
      code: error.code,
      module: error.module,
      severity: error.severity,
      category: error.category,
      context: this.config.includeContext ? this.sanitizeContext(error.context) : {},
      timestamp: error.timestamp,
      retryable: error.retryable,
      recoverable: error.recoverable,
      suggestions: error.suggestions
    };
    if (this.config.includeStack && error.stack) {
      serialized.stack = error.stack;
    }
    if (this.config.includeCause && error.cause) {
      serialized.cause = this.serialize(error.cause);
    }
    if (this.config.includeRelatedErrors && error.relatedErrors.length > 0) {
      serialized.relatedErrors = error.relatedErrors.map((e) => this.serialize(e));
    }
    return serialized;
  }
  /**
   * 序列化错误数组
   */
  serializeArray(errors) {
    return errors.map((error) => this.serialize(error));
  }
  /**
   * 序列化错误报告
   */
  serializeReport(report) {
    return {
      ...report,
      error: this.serialize(report.error)
    };
  }
  /**
   * 反序列化错误
   */
  deserialize(serialized) {
    const error = new BladeError(
      serialized.module,
      serialized.code,
      serialized.message,
      {
        severity: serialized.severity,
        category: serialized.category,
        context: serialized.context,
        timestamp: serialized.timestamp,
        retryable: serialized.retryable,
        recoverable: serialized.recoverable,
        suggestions: serialized.suggestions,
        stack: serialized.stack
      }
    );
    if (serialized.relatedErrors) {
      error.relatedErrors = serialized.relatedErrors.map((e) => this.deserialize(e));
    }
    return error;
  }
  /**
   * 反序列化错误数组
   */
  deserializeArray(serialized) {
    return serialized.map((error) => this.deserialize(error));
  }
  /**
   * 将错误转换为 JSON 字符串
   */
  toJson(error, indent) {
    const serialized = this.serialize(error);
    return JSON.stringify(serialized, null, indent);
  }
  /**
   * 从 JSON 字符串解析错误
   */
  fromJson(jsonString) {
    const serialized = JSON.parse(jsonString);
    return this.deserialize(serialized);
  }
  /**
   * 将错误转换为 URL 安全的字符串
   */
  toSafeString(error) {
    const serialized = this.serialize(error);
    const jsonString = JSON.stringify(serialized);
    return Buffer.from(jsonString).toString("base64");
  }
  /**
   * 从 URL 安全的字符串解析错误
   */
  fromSafeString(safeString) {
    const jsonString = Buffer.from(safeString, "base64").toString();
    return this.fromJson(jsonString);
  }
  /**
   * 清理敏感数据
   */
  sanitizeContext(context) {
    if (!this.config.stripSensitiveData) {
      return context;
    }
    const sanitized = {};
    const sensitiveFields = this.config.sensitiveFields || [];
    for (const [key, value] of Object.entries(context)) {
      if (this.isSensitiveField(key, sensitiveFields)) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "object" && value !== null) {
        sanitized[key] = this.sanitizeObject(value, 0);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
  /**
   * 递归清理对象中的敏感数据
   */
  sanitizeObject(obj, depth) {
    if (depth >= (this.config.maxContextDepth || 10)) {
      return "[MAX_DEPTH_REACHED]";
    }
    if (Array.isArray(obj)) {
      return obj.map(
        (item) => typeof item === "object" && item !== null ? this.sanitizeObject(item, depth + 1) : item
      );
    }
    if (typeof obj === "object" && obj !== null) {
      const sanitized = {};
      const sensitiveFields = this.config.sensitiveFields || [];
      for (const [key, value] of Object.entries(obj)) {
        if (this.isSensitiveField(key, sensitiveFields)) {
          sanitized[key] = "[REDACTED]";
        } else if (typeof value === "object" && value !== null) {
          sanitized[key] = this.sanitizeObject(value, depth + 1);
        } else {
          sanitized[key] = value;
        }
      }
      return sanitized;
    }
    return obj;
  }
  /**
   * 检查字段是否为敏感字段
   */
  isSensitiveField(fieldName, sensitiveFields) {
    const normalizedName = fieldName.toLowerCase();
    return sensitiveFields.some(
      (field) => normalizedName.includes(field.toLowerCase())
    );
  }
};
var MemoryErrorStorage = class {
  storage = /* @__PURE__ */ new Map();
  async save(errorId, serializedError) {
    this.storage.set(errorId, serializedError);
  }
  async load(errorId) {
    return this.storage.get(errorId) || null;
  }
  async delete(errorId) {
    this.storage.delete(errorId);
  }
  async list() {
    return Array.from(this.storage.keys());
  }
  async clear() {
    this.storage.clear();
  }
};
var ErrorPersistenceManager = class {
  serializer;
  storage;
  maxSize;
  constructor(storage, serializerConfig, options) {
    this.serializer = new ErrorSerializer(serializerConfig);
    this.storage = storage;
    this.maxSize = (options == null ? void 0 : options.maxSize) || 1e3;
  }
  /**
   * 保存错误
   */
  async saveError(error, customId) {
    const errorId = customId || this.generateErrorId(error);
    const serializedError = this.serializer.serialize(error);
    await this.enforceSizeLimit();
    await this.storage.save(errorId, serializedError);
    return errorId;
  }
  /**
   * 加载错误
   */
  async loadError(errorId) {
    const serialized = await this.storage.load(errorId);
    if (!serialized) {
      return null;
    }
    return this.serializer.deserialize(serialized);
  }
  /**
   * 删除错误
   */
  async deleteError(errorId) {
    await this.storage.delete(errorId);
  }
  /**
   * 列出所有错误ID
   */
  async listErrors() {
    return this.storage.list();
  }
  /**
   * 批量加载错误
   */
  async loadErrors(errorIds) {
    const errors = [];
    for (const errorId of errorIds) {
      const error = await this.loadError(errorId);
      if (error) {
        errors.push(error);
      }
    }
    return errors;
  }
  /**
   * 清空存储
   */
  async clear() {
    await this.storage.clear();
  }
  /**
   * 导出错误数据
   */
  async export(format = "json") {
    const errorIds = await this.listErrors();
    const errors = await this.loadErrors(errorIds);
    if (format === "json") {
      const serialized = errors.map((e) => this.serializer.serialize(e));
      return JSON.stringify(serialized, null, 2);
    } else if (format === "csv") {
      const headers = [
        "timestamp",
        "code",
        "message",
        "module",
        "severity",
        "category",
        "retryable",
        "recoverable"
      ];
      const rows = errors.map((error) => [
        error.timestamp,
        error.code,
        `"${error.message.replace(/"/g, '""')}"`,
        error.module,
        error.severity,
        error.category,
        error.retryable,
        error.recoverable
      ]);
      return [headers, ...rows].map((row) => row.join(",")).join("\n");
    }
    throw new Error("\u4E0D\u652F\u6301\u7684\u5BFC\u51FA\u683C\u5F0F");
  }
  /**
   * 生成错误ID
   */
  generateErrorId(error) {
    return `${error.code}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  /**
   * 强制执行存储大小限制
   */
  async enforceSizeLimit() {
    const errorIds = await this.listErrors();
    if (errorIds.length >= this.maxSize) {
      const overflow = errorIds.length - this.maxSize + 1;
      const idsToDelete = errorIds.slice(0, overflow);
      for (const id of idsToDelete) {
        await this.deleteError(id);
      }
    }
  }
};
var globalErrorSerializer = new ErrorSerializer();
var globalErrorPersistence = new ErrorPersistenceManager(
  new MemoryErrorStorage()
);

// packages/core/src/error/ErrorBoundary.ts
var ErrorBoundary = class {
  config;
  state;
  persistence;
  constructor(config = {}) {
    this.config = {
      enabled: true,
      catchUnhandledErrors: true,
      catchUnhandledRejections: true,
      maxErrors: 100,
      ...config
    };
    this.state = {
      hasError: false,
      errors: [],
      lastError: null,
      errorCount: 0,
      startTime: Date.now()
    };
    this.persistence = new ErrorPersistenceManager(
      new class MemoryStorage {
        storage = /* @__PURE__ */ new Map();
        async save(id, data) {
          this.storage.set(id, data);
        }
        async load(id) {
          return this.storage.get(id) || null;
        }
        async delete(id) {
          this.storage.delete(id);
        }
        async list() {
          return Array.from(this.storage.keys());
        }
        async clear() {
          this.storage.clear();
        }
      }()
    );
    this.setupGlobalErrorHandlers();
  }
  /**
   * 包装函数，在错误边界中执行
   */
  async wrap(fn, context) {
    if (!this.config.enabled) {
      return fn();
    }
    try {
      return await fn();
    } catch (error) {
      const bladeError = error instanceof BladeError ? error : BladeError.from(error);
      await this.handleError(bladeError, context);
      if (this.config.fallbackHandler) {
        return this.config.fallbackHandler(bladeError);
      }
      throw bladeError;
    }
  }
  /**
   * 同步包装函数
   */
  wrapSync(fn, context) {
    if (!this.config.enabled) {
      return fn();
    }
    try {
      return fn();
    } catch (error) {
      const bladeError = error instanceof BladeError ? error : BladeError.from(error);
      this.handleSyncError(bladeError, context);
      if (this.config.fallbackHandler) {
        return this.config.fallbackHandler(bladeError);
      }
      throw bladeError;
    }
  }
  /**
   * 处理错误
   */
  async handleError(error, context) {
    if (context) {
      error.context = { ...error.context, ...context };
    }
    this.state.hasError = true;
    this.state.lastError = error;
    this.state.errors.push(error);
    this.state.errorCount++;
    if (this.state.errors.length > this.config.maxErrors) {
      this.state.errors.shift();
    }
    await this.persistence.saveError(error);
    if (this.config.recoveryCallback) {
      try {
        await this.config.recoveryCallback(error);
      } catch (callbackError) {
        console.error("\u9519\u8BEF\u6062\u590D\u56DE\u8C03\u5931\u8D25:", callbackError);
      }
    }
    if (this.config.errorLogger) {
      this.config.errorLogger(error);
    } else {
      console.error("[ErrorBoundary]", error.toString());
    }
  }
  /**
   * 处理同步错误
   */
  handleSyncError(error, context) {
    if (context) {
      error.context = { ...error.context, ...context };
    }
    this.state.hasError = true;
    this.state.lastError = error;
    this.state.errors.push(error);
    this.state.errorCount++;
    setImmediate(() => {
      this.persistence.saveError(error).catch((err) => {
        console.error("\u9519\u8BEF\u6301\u4E45\u5316\u5931\u8D25:", err);
      });
    });
    if (this.config.recoveryCallback) {
      try {
        this.config.recoveryCallback(error);
      } catch (callbackError) {
        console.error("\u9519\u8BEF\u6062\u590D\u56DE\u8C03\u5931\u8D25:", callbackError);
      }
    }
    if (this.config.errorLogger) {
      this.config.errorLogger(error);
    } else {
      console.error("[ErrorBoundary]", error.toString());
    }
  }
  /**
   * 获取错误边界状态
   */
  getState() {
    return { ...this.state };
  }
  /**
   * 获取错误历史
   */
  async getErrorHistory(limit) {
    const errorIds = await this.persistence.listErrors();
    let errors = await this.persistence.loadErrors(errorIds);
    errors = errors.sort((a, b) => b.timestamp - a.timestamp);
    return limit ? errors.slice(0, limit) : errors;
  }
  /**
   * 清除错误历史
   */
  async clearErrorHistory() {
    await this.persistence.clear();
    this.state = {
      hasError: false,
      errors: [],
      lastError: null,
      errorCount: 0,
      startTime: Date.now()
    };
  }
  /**
   * 重置错误边界
   */
  reset() {
    this.state = {
      hasError: false,
      errors: [],
      lastError: null,
      errorCount: 0,
      startTime: Date.now()
    };
  }
  /**
   * 设置全局错误处理器
   */
  setupGlobalErrorHandlers() {
    if (this.config.catchUnhandledErrors) {
      process.on("uncaughtException", async (error) => {
        const bladeError = error instanceof Error ? BladeError.from(error) : new BladeError("CORE" /* CORE */, "INTERNAL_ERROR", String(error));
        await this.handleError(bladeError, {
          source: "uncaughtException",
          processInfo: {
            pid: process.pid,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage()
          }
        });
      });
    }
    if (this.config.catchUnhandledRejections) {
      process.on("unhandledRejection", async (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        const bladeError = BladeError.from(error, "CORE" /* CORE */);
        await this.handleError(bladeError, {
          source: "unhandledRejection",
          processInfo: {
            pid: process.pid,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage()
          }
        });
      });
    }
  }
};
var ErrorDebugTools = class {
  config;
  traces = /* @__PURE__ */ new Map();
  constructor(config = {}) {
    this.config = {
      enabled: false,
      captureStackTraces: true,
      captureContext: true,
      captureMemoryUsage: true,
      captureExecutionTime: true,
      maxTraces: 100,
      logLevel: "debug",
      ...config
    };
  }
  /**
   * 开始追踪
   */
  startTrace(operationId, context) {
    if (!this.config.enabled) {
      return;
    }
    const trace = {
      id: this.generateTraceId(),
      timestamp: Date.now(),
      error: new BladeError("CORE" /* CORE */, "0004", "\u8FFD\u8E2A\u5F00\u59CB", {
        category: "DEBUG",
        severity: "DEBUG",
        context
      })
    };
    if (this.config.captureMemoryUsage) {
      trace.memoryUsage = process.memoryUsage();
    }
    this.traces.set(operationId, trace);
    this.logTrace("\u5F00\u59CB\u8FFD\u8E2A", trace);
  }
  /**
   * 结束追踪
   */
  endTrace(operationId, error) {
    if (!this.config.enabled) {
      return;
    }
    const trace = this.traces.get(operationId);
    if (!trace) {
      return;
    }
    if (error) {
      trace.error = error instanceof BladeError ? error : BladeError.from(error);
    }
    if (this.config.captureExecutionTime) {
      trace.executionTime = Date.now() - trace.timestamp;
    }
    if (this.config.captureStackTraces) {
      trace.stack = new Error().stack;
    }
    if (this.config.captureMemoryUsage) {
      trace.memoryUsage = process.memoryUsage();
    }
    this.logTrace("\u7ED3\u675F\u8FFD\u8E2A", trace);
    this.traces.delete(operationId);
  }
  /**
   * 捕获当前状态
   */
  captureState(operationId, additionalContext) {
    if (!this.config.enabled) {
      return;
    }
    const trace = this.traces.get(operationId);
    if (!trace) {
      return;
    }
    const state = {
      timestamp: Date.now(),
      memoryUsage: this.config.captureMemoryUsage ? process.memoryUsage() : void 0,
      context: additionalContext,
      stack: this.config.captureStackTraces ? new Error().stack : void 0
    };
    if (!trace.context) {
      trace.context = {};
    }
    trace.context = { ...trace.context, ...state };
    this.logTrace("\u72B6\u6001\u6355\u83B7", trace);
  }
  /**
   * 获取追踪信息
   */
  getTrace(operationId) {
    return this.traces.get(operationId);
  }
  /**
   * 获取所有追踪
   */
  getAllTraces() {
    return Array.from(this.traces.values());
  }
  /**
   * 清除所有追踪
   */
  clearTraces() {
    this.traces.clear();
  }
  /**
   * 生成调试报告
   */
  generateDebugReport() {
    const traces = Array.from(this.traces.values());
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    let report = `# \u9519\u8BEF\u8C03\u8BD5\u62A5\u544A
`;
    report += `\u751F\u6210\u65F6\u95F4: ${timestamp}
`;
    report += `\u8FFD\u8E2A\u6570\u91CF: ${traces.length}

`;
    for (const trace of traces) {
      report += `## \u8FFD\u8E2A ID: ${trace.id}
`;
      report += `- \u5F00\u59CB\u65F6\u95F4: ${new Date(trace.timestamp).toISOString()}
`;
      report += `- \u6267\u884C\u65F6\u95F4: ${trace.executionTime || "N/A"}ms
`;
      report += `- \u9519\u8BEF: ${trace.error.message}
`;
      if (trace.memoryUsage) {
        report += `- \u5185\u5B58\u4F7F\u7528: ${Math.round(trace.memoryUsage.heapUsed / 1024 / 1024)}MB
`;
      }
      if (trace.context) {
        report += `- \u4E0A\u4E0B\u6587: ${JSON.stringify(trace.context, null, 2)}
`;
      }
      if (trace.stack) {
        report += `- \u5806\u6808\u8DDF\u8E2A:
\`\`\`
${trace.stack}
\`\`\`
`;
      }
      report += "\n";
    }
    return report;
  }
  /**
   * 启用调试模式
   */
  enable() {
    this.config.enabled = true;
  }
  /**
   * 禁用调试模式
   */
  disable() {
    this.config.enabled = false;
  }
  /**
   * 记录追踪信息
   */
  logTrace(message, trace) {
    if (!this.config.enabled) {
      return;
    }
    const levelMap = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    const currentLevel = levelMap[this.config.logLevel];
    const messageLevel = trace.error.severity === "CRITICAL" || trace.error.severity === "ERROR" ? 3 : 0;
    if (messageLevel >= currentLevel) {
      console.log(`[DebugTools] ${message}:`, {
        traceId: trace.id,
        operation: trace.error.message,
        timestamp: trace.timestamp,
        executionTime: trace.executionTime
      });
    }
  }
  /**
   * 生成追踪ID
   */
  generateTraceId() {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
};
var globalErrorBoundary = new ErrorBoundary();
var globalDebugTools = new ErrorDebugTools();

// packages/core/src/config/defaults.ts
var DEFAULT_CONFIG = {
  // 认证配置
  apiKey: "",
  baseUrl: "https://apis.iflow.cn/v1",
  modelName: "Qwen3-Coder",
  // 搜索配置
  searchApiKey: "",
  theme: "GitHub",
  sandbox: "docker",
  // UI 配置
  hideTips: false,
  hideBanner: false,
  // 使用配置
  maxSessionTurns: 10,
  // 工具配置
  toolDiscoveryCommand: "bin/get_tools",
  toolCallCommand: "bin/call_tool",
  // 遥测配置
  telemetryEnabled: true,
  telemetryTarget: "local",
  otlpEndpoint: "http://localhost:4317",
  logPrompts: false,
  usageStatisticsEnabled: true,
  // 调试配置
  debug: false
};
var ENV_MAPPING = {
  BLADE_API_KEY: "apiKey",
  BLADE_BASE_URL: "baseUrl",
  BLADE_MODEL: "modelName",
  BLADE_SEARCH_API_KEY: "searchApiKey",
  BLADE_THEME: "theme",
  BLADE_SANDBOX: "sandbox",
  BLADE_MAX_TURNS: "maxSessionTurns",
  BLADE_DEBUG: "debug"
};

// packages/core/src/config/ConfigManager.ts
var ConfigManager = class {
  config;
  subscribers = [];
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.loadFromEnvironment();
  }
  loadFromEnvironment() {
    try {
      for (const [envKey, configKey] of Object.entries(ENV_MAPPING)) {
        const envValue = process.env[envKey];
        if (envValue) {
          this.config[configKey] = this.parseEnvValue(envValue);
        }
      }
    } catch (error) {
      const bladeError = error instanceof Error ? ErrorFactory.fromNativeError(error, "\u73AF\u5883\u53D8\u91CF\u52A0\u8F7D\u5931\u8D25") : new ConfigError("CONFIG_LOAD_FAILED", "\u73AF\u5883\u53D8\u91CF\u52A0\u8F7D\u5931\u8D25");
      globalErrorMonitor.monitor(bladeError);
      console.warn("\u73AF\u5883\u53D8\u91CF\u52A0\u8F7D\u5931\u8D25\uFF0C\u4F7F\u7528\u9ED8\u8BA4\u914D\u7F6E:", error);
    }
  }
  parseEnvValue(value) {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
    const numValue = Number(value);
    if (!isNaN(numValue)) return numValue;
    return value;
  }
  getConfig() {
    return { ...this.config };
  }
  updateConfig(updates) {
    try {
      this.config = { ...this.config, ...updates };
      this.notifySubscribers();
    } catch (error) {
      const bladeError = error instanceof Error ? ErrorFactory.fromNativeError(error, "\u914D\u7F6E\u66F4\u65B0\u5931\u8D25") : new ConfigError("CONFIG_LOAD_FAILED", "\u914D\u7F6E\u66F4\u65B0\u5931\u8D25");
      globalErrorMonitor.monitor(bladeError);
      throw bladeError;
    }
  }
  async get(key) {
    return this.config[key];
  }
  async set(key, value) {
    try {
      this.config[key] = value;
      this.notifySubscribers();
    } catch (error) {
      const bladeError = error instanceof Error ? ErrorFactory.fromNativeError(error, "\u914D\u7F6E\u8BBE\u7F6E\u5931\u8D25") : new ConfigError("CONFIG_LOAD_FAILED", "\u914D\u7F6E\u8BBE\u7F6E\u5931\u8D25");
      globalErrorMonitor.monitor(bladeError);
      throw bladeError;
    }
  }
  async reload() {
    try {
      this.config = { ...DEFAULT_CONFIG };
      this.loadFromEnvironment();
      this.notifySubscribers();
      return this.getConfig();
    } catch (error) {
      const bladeError = error instanceof Error ? ErrorFactory.fromNativeError(error, "\u914D\u7F6E\u91CD\u8F7D\u5931\u8D25") : new ConfigError("CONFIG_LOAD_FAILED", "\u914D\u7F6E\u91CD\u8F7D\u5931\u8D25");
      globalErrorMonitor.monitor(bladeError);
      throw bladeError;
    }
  }
  enableHotReload() {
    console.warn("\u70ED\u91CD\u8F7D\u529F\u80FD\u5728\u7B80\u5316\u7248\u672C\u4E2D\u4E0D\u53EF\u7528");
  }
  disableHotReload() {
  }
  subscribe(callback) {
    this.subscribers.push(callback);
    return () => {
      const index = this.subscribers.indexOf(callback);
      if (index > -1) {
        this.subscribers.splice(index, 1);
      }
    };
  }
  notifySubscribers() {
    const config = this.getConfig();
    this.subscribers.forEach((callback) => {
      try {
        callback(config);
      } catch (error) {
        console.error("\u914D\u7F6E\u8BA2\u9605\u56DE\u8C03\u6267\u884C\u5931\u8D25:", error);
      }
    });
  }
  validateConfig(config) {
    const errors = [];
    if (config.apiKey !== void 0 && typeof config.apiKey !== "string") {
      errors.push({ path: "apiKey", message: "API Key \u5FC5\u987B\u662F\u5B57\u7B26\u4E32" });
    }
    if (config.baseUrl !== void 0 && typeof config.baseUrl !== "string") {
      errors.push({ path: "baseUrl", message: "Base URL \u5FC5\u987B\u662F\u5B57\u7B26\u4E32" });
    }
    if (config.modelName !== void 0 && typeof config.modelName !== "string") {
      errors.push({ path: "modelName", message: "Model Name \u5FC5\u987B\u662F\u5B57\u7B26\u4E32" });
    }
    return errors;
  }
  validateConfigValue(key, value) {
    const errors = [];
    switch (key) {
      case "apiKey":
      case "baseUrl":
      case "modelName":
      case "searchApiKey":
        if (value !== void 0 && typeof value !== "string") {
          errors.push({ path: key, message: `${key} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32` });
        }
        break;
      case "maxSessionTurns":
        if (value !== void 0 && (typeof value !== "number" || value < 1)) {
          errors.push({ path: key, message: `${key} \u5FC5\u987B\u662F\u5927\u4E8E0\u7684\u6570\u5B57` });
        }
        break;
      case "debug":
      case "hideTips":
      case "hideBanner":
      case "usageStatisticsEnabled":
        if (value !== void 0 && typeof value !== "boolean") {
          errors.push({ path: key, message: `${key} \u5FC5\u987B\u662F\u5E03\u5C14\u503C` });
        }
        break;
    }
    return errors;
  }
};

// packages/core/src/llm/LLMManager.ts
var LLMManager = class {
  config = {};
  constructor(config) {
    this.config = {
      apiKey: config.apiKey || "",
      baseUrl: config.baseUrl || "https://apis.iflow.cn/v1",
      modelName: config.modelName || "Qwen3-Coder"
    };
  }
  /**
   * 设置配置
   */
  configure(config) {
    Object.assign(this.config, config);
  }
  /**
   * 基础调用
   */
  async send(request) {
    const config = { ...this.config, ...request };
    if (!config.apiKey) {
      throw ErrorFactory.createLLMError("API_KEY_MISSING", "API\u5BC6\u94A5\u672A\u914D\u7F6E");
    }
    if (!config.baseUrl) {
      throw ErrorFactory.createLLMError("BASE_URL_MISSING", "Base URL\u672A\u914D\u7F6E");
    }
    if (!config.modelName) {
      throw ErrorFactory.createLLMError("MODEL_NAME_MISSING", "\u6A21\u578B\u540D\u79F0\u672A\u914D\u7F6E");
    }
    if (!config.messages) {
      throw ErrorFactory.createLLMError("REQUEST_FAILED", "\u6D88\u606F\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A");
    }
    const payload = {
      model: config.modelName,
      messages: config.messages,
      temperature: config.temperature || 0.7,
      max_tokens: config.maxTokens || 2048,
      stream: config.stream || false
    };
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    };
    return globalRetryManager.execute(async () => {
      try {
        const response = await fetch(config.baseUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(config.timeout || 3e4)
        });
        if (!response.ok) {
          throw ErrorFactory.createHttpError(
            response.status,
            config.baseUrl,
            response.statusText
          );
        }
        const data = await response.json();
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
          throw ErrorFactory.createLLMError("RESPONSE_PARSE_ERROR", "\u54CD\u5E94\u683C\u5F0F\u9519\u8BEF");
        }
        return {
          content: data.choices[0].message.content || "",
          usage: data.usage,
          model: data.model
        };
      } catch (error) {
        if (error instanceof LLMError || error instanceof NetworkError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw ErrorFactory.createTimeoutError("LLM API\u8C03\u7528", config.timeout || 3e4);
        }
        throw ErrorFactory.fromNativeError(error, "LLM\u8C03\u7528\u5931\u8D25");
      }
    }, "LLM_API_CALL");
  }
  /**
   * 快速对话
   */
  async chat(message) {
    return await this.send({ messages: [{ role: "user", content: message }] }).then((r) => r.content);
  }
  /**
   * 系统对话
   */
  async chatWithSystem(systemPrompt, userMessage) {
    return await this.send({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ]
    }).then((r) => r.content);
  }
  /**
   * 多轮对话
   */
  async conversation(messages) {
    return await this.send({ messages }).then((r) => r.content);
  }
};

// packages/core/src/agent/Agent.ts
var Agent = class {
  configManager;
  llmManager;
  constructor(config) {
    this.configManager = new ConfigManager();
    if (config) {
      this.configManager.updateConfig(config);
    }
    const bladeConfig = this.configManager.getConfig();
    this.llmManager = new LLMManager({
      apiKey: bladeConfig.apiKey,
      baseUrl: bladeConfig.baseUrl,
      modelName: bladeConfig.modelName
    });
  }
  /**
   * 基础聊天
   */
  async chat(message) {
    return await this.llmManager.chat(message);
  }
  /**
   * 系统提示词聊天
   */
  async chatWithSystem(systemPrompt, userMessage) {
    return await this.llmManager.chatWithSystem(systemPrompt, userMessage);
  }
  /**
   * 多轮对话
   */
  async conversation(messages) {
    return await this.llmManager.conversation(messages);
  }
  /**
   * 获取当前配置
   */
  getConfig() {
    return this.configManager.getConfig();
  }
  /**
   * 更新配置
   */
  updateConfig(config) {
    this.configManager.updateConfig(config);
    this.llmManager.configure({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      modelName: config.modelName
    });
  }
};

// packages/core/src/context/ContextManager.ts
import * as crypto from "crypto";

// packages/core/src/context/storage/PersistentStore.ts
import * as fs from "fs/promises";
import * as path from "path";

// packages/core/src/agent/ToolComponent.ts
import { EventEmitter as EventEmitter2 } from "events";

// packages/core/src/tools/ToolManager.ts
import { randomUUID } from "crypto";
import { EventEmitter } from "events";

// packages/core/src/tools/builtin/file-system.ts
import { promises as fs2 } from "fs";
import { basename, dirname as dirname2, extname, join as join3, resolve as resolve2 } from "path";

// packages/core/src/tools/base/ConfirmableToolBase.ts
import chalk from "chalk";
import { exec } from "child_process";
import inquirer from "inquirer";
import { promisify } from "util";
var execAsync = promisify(exec);
var ConfirmableToolBase = class {
  /** 工具版本 */
  version = "1.0.0";
  /** 工具作者 */
  author = "Agent CLI";
  /** 工具分类 */
  category;
  /** 工具标签 */
  tags;
  /** 必需参数列表 */
  required;
  /**
   * 工具执行入口
   */
  async execute(params) {
    try {
      const processedParams = await this.preprocessParameters(params);
      const command = await this.buildCommand(processedParams);
      const confirmationOptions = this.getConfirmationOptions(processedParams);
      const workingDirectory = this.getWorkingDirectory(processedParams);
      const preCheckResult = await this.preCheckCommand(command, workingDirectory, processedParams);
      if (!preCheckResult.valid) {
        return await this.handlePreCheckFailure(
          preCheckResult,
          workingDirectory,
          confirmationOptions
        );
      }
      if (!confirmationOptions.skipConfirmation) {
        const confirmed = await this.confirmExecution(
          command,
          workingDirectory,
          confirmationOptions,
          processedParams
        );
        if (!confirmed) {
          return {
            success: false,
            error: "\u7528\u6237\u53D6\u6D88\u6267\u884C",
            cancelled: true
          };
        }
      }
      return await this.executeCommand(
        command,
        workingDirectory,
        confirmationOptions,
        processedParams
      );
    } catch (error) {
      return {
        success: false,
        error: `\u5DE5\u5177\u6267\u884C\u5931\u8D25: ${error.message}`
      };
    }
  }
  /**
   * 预处理参数 - 子类可重写进行参数验证和转换
   */
  async preprocessParameters(params) {
    return params;
  }
  /**
   * 获取确认选项 - 子类可重写自定义确认行为
   */
  getConfirmationOptions(params) {
    return {
      skipConfirmation: params.skipConfirmation || false,
      riskLevel: params.riskLevel || "moderate" /* MODERATE */,
      showPreview: params.showPreview !== false,
      timeout: params.timeout || 3e4
    };
  }
  /**
   * 获取工作目录 - 子类可重写
   */
  getWorkingDirectory(params) {
    return params.workingDirectory || params.path || process.cwd();
  }
  /**
   * 预检查命令 - 子类可重写进行特定的命令检查
   */
  async preCheckCommand(_command, _workingDirectory, _params) {
    return { valid: true };
  }
  /**
   * 处理预检查失败 - 提供建议选项
   */
  async handlePreCheckFailure(preCheckResult, workingDirectory, confirmationOptions) {
    console.log(chalk.yellow(`\u26A0\uFE0F  \u9884\u68C0\u67E5\u53D1\u73B0\u95EE\u9898: ${preCheckResult.message}`));
    if (preCheckResult.suggestions && preCheckResult.suggestions.length > 0) {
      console.log(chalk.blue("\n\u{1F4A1} \u5EFA\u8BAE\u7684\u66FF\u4EE3\u65B9\u6848:"));
      const choices = preCheckResult.suggestions.map((suggestion, index) => ({
        name: `${chalk.cyan(suggestion.command)} ${chalk.gray(`- ${suggestion.description}`)}`,
        value: index,
        short: suggestion.command
      }));
      choices.push({ name: chalk.gray("\u53D6\u6D88\u6267\u884C"), value: -1, short: "\u53D6\u6D88" });
      const { selectedIndex } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedIndex",
          message: "\u8BF7\u9009\u62E9\u8981\u6267\u884C\u7684\u547D\u4EE4:",
          choices,
          pageSize: 10
        }
      ]);
      if (selectedIndex === -1) {
        return {
          success: false,
          error: "\u7528\u6237\u53D6\u6D88\u6267\u884C",
          cancelled: true
        };
      }
      const selectedSuggestion = preCheckResult.suggestions[selectedIndex];
      return await this.executeCommand(
        selectedSuggestion.command,
        workingDirectory,
        {
          ...confirmationOptions,
          riskLevel: selectedSuggestion.riskLevel || confirmationOptions.riskLevel
        },
        {}
      );
    }
    return {
      success: false,
      error: preCheckResult.message || "\u9884\u68C0\u67E5\u5931\u8D25"
    };
  }
  /**
   * 用户确认执行
   */
  async confirmExecution(command, workingDirectory, options, params) {
    console.log(chalk.blue("\n\u{1F4CB} \u5EFA\u8BAE\u6267\u884C\u4EE5\u4E0B\u547D\u4EE4:"));
    console.log(chalk.cyan(`  ${command}`));
    const description = this.getExecutionDescription(params);
    if (description) {
      console.log(chalk.gray(`  \u8BF4\u660E: ${description}`));
    }
    console.log(chalk.gray(`  \u5DE5\u4F5C\u76EE\u5F55: ${workingDirectory}`));
    console.log(chalk.gray(`  \u98CE\u9669\u7EA7\u522B: ${this.getRiskLevelDisplay(options.riskLevel)}`));
    if (options.showPreview) {
      const previewInfo = await this.getExecutionPreview(command, workingDirectory, params);
      if (previewInfo) {
        console.log(chalk.blue("\n\u{1F50D} \u6267\u884C\u9884\u89C8:"));
        console.log(chalk.gray(previewInfo));
      }
    }
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: options.confirmMessage || "\u662F\u5426\u6267\u884C\u6B64\u547D\u4EE4\uFF1F",
        default: false
      }
    ]);
    return confirm;
  }
  /**
   * 执行命令
   */
  async executeCommand(command, workingDirectory, options, params) {
    console.log(chalk.blue("\n\u26A1 \u6B63\u5728\u6267\u884C\u547D\u4EE4..."));
    const startTime = Date.now();
    try {
      const result = await execAsync(command, {
        cwd: workingDirectory,
        timeout: options.timeout
      });
      const duration = Date.now() - startTime;
      console.log(chalk.green(`\u2705 \u547D\u4EE4\u6267\u884C\u6210\u529F (${duration}ms)`));
      if (result.stdout) {
        console.log("\n\u{1F4E4} \u8F93\u51FA:");
        console.log(result.stdout);
      }
      const processedResult = await this.postProcessResult(result, params);
      return {
        success: true,
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        workingDirectory,
        duration,
        data: processedResult
      };
    } catch (error) {
      console.log(chalk.red(`\u274C \u547D\u4EE4\u6267\u884C\u5931\u8D25: ${error.message}`));
      if (error.stdout) {
        console.log("\n\u{1F4E4} \u6807\u51C6\u8F93\u51FA:");
        console.log(error.stdout);
      }
      if (error.stderr) {
        console.log("\n\u{1F6A8} \u9519\u8BEF\u8F93\u51FA:");
        console.log(error.stderr);
      }
      return {
        success: false,
        error: error.message,
        command,
        stdout: error.stdout || "",
        stderr: error.stderr || "",
        exitCode: error.code,
        workingDirectory
      };
    }
  }
  /**
   * 获取执行描述 - 子类可重写提供更详细的说明
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getExecutionDescription(_params) {
    return void 0;
  }
  /**
   * 获取执行预览 - 子类可重写提供执行前的预览信息
   */
  async getExecutionPreview(_command, _workingDirectory, _params) {
    return void 0;
  }
  /**
   * 后处理结果 - 子类可重写对执行结果进行额外处理
   */
  async postProcessResult(result, _params) {
    return result;
  }
  /**
   * 获取风险级别显示
   */
  getRiskLevelDisplay(level) {
    switch (level) {
      case "safe" /* SAFE */:
        return chalk.green("\u5B89\u5168");
      case "moderate" /* MODERATE */:
        return chalk.yellow("\u4E2D\u7B49");
      case "high" /* HIGH */:
        return chalk.red("\u9AD8\u98CE\u9669");
      case "critical" /* CRITICAL */:
        return chalk.redBright.bold("\u6781\u9AD8\u98CE\u9669");
      default:
        return chalk.gray("\u672A\u77E5");
    }
  }
};

// packages/core/src/tools/builtin/file-system.ts
var fileReadTool = {
  name: "file_read",
  description: "\u8BFB\u53D6\u6587\u4EF6\u5185\u5BB9",
  version: "1.0.0",
  category: "filesystem",
  tags: ["file", "read", "content"],
  parameters: {
    path: {
      type: "string",
      description: "\u6587\u4EF6\u8DEF\u5F84",
      required: true
    },
    encoding: {
      type: "string",
      description: "\u6587\u4EF6\u7F16\u7801",
      enum: ["utf8", "base64", "hex"],
      default: "utf8"
    },
    maxSize: {
      type: "number",
      description: "\u6700\u5927\u6587\u4EF6\u5927\u5C0F\uFF08\u5B57\u8282\uFF09",
      default: 1024 * 1024
      // 1MB
    }
  },
  required: ["path"],
  async execute(params) {
    const { path: path6, encoding, maxSize } = params;
    try {
      const resolvedPath = resolve2(path6);
      const stats = await fs2.stat(resolvedPath);
      if (!stats.isFile()) {
        return {
          success: false,
          error: "\u6307\u5B9A\u8DEF\u5F84\u4E0D\u662F\u6587\u4EF6"
        };
      }
      if (stats.size > maxSize) {
        return {
          success: false,
          error: `\u6587\u4EF6\u592A\u5927 (${stats.size} \u5B57\u8282)\uFF0C\u8D85\u8FC7\u9650\u5236 (${maxSize} \u5B57\u8282)`
        };
      }
      const content = await fs2.readFile(resolvedPath, encoding);
      return {
        success: true,
        data: {
          path: resolvedPath,
          content,
          encoding,
          size: stats.size,
          modified: stats.mtime,
          created: stats.birthtime
        }
      };
    } catch (error) {
      const fileSystemError = ErrorFactory.createFileSystemError(
        "FILE_READ_FAILED",
        `\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25: ${error.message}`,
        {
          context: { path: path6, encoding },
          retryable: true,
          suggestions: ["\u68C0\u67E5\u6587\u4EF6\u8DEF\u5F84\u662F\u5426\u6B63\u786E", "\u786E\u8BA4\u6587\u4EF6\u6743\u9650\u8BBE\u7F6E", "\u786E\u8BA4\u6587\u4EF6\u672A\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528"]
        }
      );
      globalErrorMonitor.monitor(fileSystemError);
      return {
        success: false,
        error: fileSystemError.message
      };
    }
  }
};
var FileWriteTool = class extends ConfirmableToolBase {
  name = "file_write";
  description = "\u5199\u5165\u6587\u4EF6\u5185\u5BB9\uFF08\u9700\u8981\u7528\u6237\u786E\u8BA4\uFF09";
  category = "filesystem";
  tags = ["file", "write", "create"];
  parameters = {
    path: {
      type: "string",
      required: true,
      description: "\u6587\u4EF6\u8DEF\u5F84"
    },
    content: {
      type: "string",
      required: true,
      description: "\u6587\u4EF6\u5185\u5BB9"
    },
    encoding: {
      type: "string",
      required: false,
      description: "\u6587\u4EF6\u7F16\u7801",
      default: "utf8"
    },
    createDirectories: {
      type: "boolean",
      required: false,
      description: "\u662F\u5426\u521B\u5EFA\u76EE\u5F55\u7ED3\u6784",
      default: true
    },
    overwrite: {
      type: "boolean",
      required: false,
      description: "\u662F\u5426\u8986\u76D6\u5DF2\u5B58\u5728\u7684\u6587\u4EF6",
      default: false
    },
    skipConfirmation: {
      type: "boolean",
      required: false,
      description: "\u8DF3\u8FC7\u7528\u6237\u786E\u8BA4\u76F4\u63A5\u6267\u884C",
      default: false
    },
    riskLevel: {
      type: "string",
      required: false,
      description: "\u98CE\u9669\u7EA7\u522B\uFF1Asafe, moderate, high, critical",
      default: "moderate"
    }
  };
  required = ["path", "content"];
  /**
   * 预处理参数
   */
  async preprocessParameters(params) {
    const { path: path6, content } = params;
    if (path6.includes("..") || path6.startsWith("/") || path6.includes("\\")) {
      if (path6.includes("..")) {
        throw ErrorFactory.createValidationError("path", path6, "\u4E0D\u80FD\u5305\u542B\u76F8\u5BF9\u8DEF\u5F84\u64CD\u4F5C\u7B26", {
          suggestions: ["\u4F7F\u7528\u76F8\u5BF9\u8DEF\u5F84\u800C\u4E0D\u662F\u7EDD\u5BF9\u8DEF\u5F84"],
          retryable: false
        });
      }
    }
    if (content.length > 10 * 1024 * 1024) {
      throw ErrorFactory.createFileSystemError("FILE_TOO_LARGE", "\u6587\u4EF6\u5185\u5BB9\u8FC7\u5927\uFF08\u8D85\u8FC710MB\uFF09", {
        context: { contentLength: content.length, maxSize: 10 * 1024 * 1024 },
        suggestions: ["\u51CF\u5C11\u5185\u5BB9\u5927\u5C0F", "\u5206\u6279\u5904\u7406\u5927\u6587\u4EF6"],
        retryable: false
      });
    }
    return params;
  }
  /**
   * 构建命令描述（非实际命令）
   */
  async buildCommand(params) {
    const { path: path6, content, encoding, overwrite } = params;
    return `\u5199\u5165\u6587\u4EF6: ${path6} (${content.length}\u5B57\u7B26, ${encoding}\u7F16\u7801${overwrite ? ", \u8986\u76D6\u6A21\u5F0F" : ""})`;
  }
  /**
   * 获取确认选项
   */
  getConfirmationOptions(params) {
    const baseOptions = super.getConfirmationOptions(params);
    let riskLevel = "moderate" /* MODERATE */;
    let confirmMessage = "";
    if (params.overwrite) {
      riskLevel = "high" /* HIGH */;
      confirmMessage = `\u26A0\uFE0F  \u5C06\u8986\u76D6\u6587\u4EF6 "${params.path}"\uFF0C\u662F\u5426\u7EE7\u7EED\uFF1F`;
    } else {
      riskLevel = "moderate" /* MODERATE */;
      confirmMessage = `\u5199\u5165\u6587\u4EF6 "${params.path}"\uFF1F`;
    }
    return {
      ...baseOptions,
      riskLevel,
      confirmMessage
    };
  }
  /**
   * 预检查命令
   */
  async preCheckCommand(_command, _workingDirectory, params) {
    try {
      const resolvedPath = resolve2(params.path);
      try {
        await fs2.access(resolvedPath);
        if (!params.overwrite) {
          return {
            valid: false,
            message: `\u6587\u4EF6 "${params.path}" \u5DF2\u5B58\u5728`,
            suggestions: [
              {
                command: `\u5199\u5165\u6587\u4EF6: ${params.path} (\u8986\u76D6\u6A21\u5F0F)`,
                description: "\u8986\u76D6\u5DF2\u5B58\u5728\u7684\u6587\u4EF6",
                riskLevel: "high" /* HIGH */
              }
            ]
          };
        }
      } catch {
      }
      const dir = dirname2(resolvedPath);
      try {
        await fs2.access(dir);
      } catch {
        if (!params.createDirectories) {
          return {
            valid: false,
            message: `\u76EE\u5F55 "${dir}" \u4E0D\u5B58\u5728`,
            suggestions: [
              {
                command: `\u5199\u5165\u6587\u4EF6: ${params.path} (\u521B\u5EFA\u76EE\u5F55)`,
                description: "\u81EA\u52A8\u521B\u5EFA\u76EE\u5F55\u7ED3\u6784",
                riskLevel: "moderate" /* MODERATE */
              }
            ]
          };
        }
      }
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        message: `\u6587\u4EF6\u9884\u68C0\u67E5\u5931\u8D25: ${error.message}`
      };
    }
  }
  /**
   * 获取执行描述
   */
  getExecutionDescription(params) {
    const { path: path6, content, encoding, overwrite, createDirectories } = params;
    let description = `\u5199\u5165\u6587\u4EF6: ${path6} (${content.length}\u5B57\u7B26, ${encoding}\u7F16\u7801)`;
    if (overwrite) {
      description += " - \u8986\u76D6\u6A21\u5F0F";
    }
    if (createDirectories) {
      description += " - \u81EA\u52A8\u521B\u5EFA\u76EE\u5F55";
    }
    return description;
  }
  /**
   * 获取执行预览
   */
  async getExecutionPreview(_command, _workingDirectory, params) {
    const { path: path6, content } = params;
    const resolvedPath = resolve2(path6);
    let preview = `\u6587\u4EF6\u8DEF\u5F84: ${resolvedPath}
`;
    preview += `\u5185\u5BB9\u957F\u5EA6: ${content.length} \u5B57\u7B26
`;
    if (content.length <= 200) {
      preview += `\u5185\u5BB9\u9884\u89C8:
${content}`;
    } else {
      preview += `\u5185\u5BB9\u9884\u89C8:
${content.substring(0, 200)}...(\u5DF2\u622A\u65AD)`;
    }
    return preview;
  }
  /**
   * 执行文件写入
   */
  async executeCommand(_command, _workingDirectory, _options, params) {
    const { path: path6, content, encoding, createDirectories } = params;
    try {
      const resolvedPath = resolve2(path6);
      if (createDirectories) {
        const dir = dirname2(resolvedPath);
        try {
          await fs2.mkdir(dir, { recursive: true });
        } catch (error) {
          const mkdirError = ErrorFactory.createFileSystemError(
            "DISK_FULL",
            `\u521B\u5EFA\u76EE\u5F55\u5931\u8D25: ${error.message}`,
            {
              context: { directory: dir },
              retryable: false,
              suggestions: ["\u68C0\u67E5\u78C1\u76D8\u7A7A\u95F4", "\u786E\u8BA4\u76EE\u5F55\u6743\u9650"]
            }
          );
          globalErrorMonitor.monitor(mkdirError);
          throw mkdirError;
        }
      }
      await fs2.writeFile(resolvedPath, content, encoding);
      const stats = await fs2.stat(resolvedPath);
      return {
        success: true,
        data: {
          path: resolvedPath,
          size: stats.size,
          encoding,
          created: stats.birthtime,
          modified: stats.mtime
        }
      };
    } catch (error) {
      if (error instanceof FileSystemError) {
        throw error;
      }
      const fileSystemError = ErrorFactory.createFileSystemError(
        "FILE_WRITE_FAILED",
        `\u6587\u4EF6\u5199\u5165\u5931\u8D25: ${error.message}`,
        {
          context: { path: path6, encoding },
          retryable: true,
          suggestions: ["\u68C0\u67E5\u78C1\u76D8\u7A7A\u95F4", "\u786E\u8BA4\u6587\u4EF6\u6743\u9650", "\u786E\u8BA4\u76EE\u5F55\u662F\u5426\u5B58\u5728"]
        }
      );
      globalErrorMonitor.monitor(fileSystemError);
      return {
        success: false,
        error: fileSystemError.message
      };
    }
  }
};
var fileWriteTool = new FileWriteTool();

// packages/core/src/tools/builtin/git/git-add.ts
import { exec as exec2 } from "child_process";
import { promisify as promisify2 } from "util";
var execAsync2 = promisify2(exec2);
var GitAddTool = class extends ConfirmableToolBase {
  name = "git_add";
  description = "\u6DFB\u52A0\u6587\u4EF6\u5230Git\u6682\u5B58\u533A\uFF08\u9700\u8981\u7528\u6237\u786E\u8BA4\uFF09";
  category = "git";
  tags = ["git", "add", "stage", "index"];
  parameters = {
    path: {
      type: "string",
      required: false,
      description: "\u4ED3\u5E93\u8DEF\u5F84\uFF0C\u9ED8\u8BA4\u4E3A\u5F53\u524D\u76EE\u5F55",
      default: "."
    },
    files: {
      type: "string",
      required: false,
      description: "\u8981\u6DFB\u52A0\u7684\u6587\u4EF6\u8DEF\u5F84\uFF0C\u652F\u6301\u901A\u914D\u7B26\uFF0C\u7528\u7A7A\u683C\u5206\u9694\u591A\u4E2A\u6587\u4EF6",
      default: ""
    },
    all: {
      type: "boolean",
      required: false,
      description: "\u6DFB\u52A0\u6240\u6709\u4FEE\u6539\u7684\u6587\u4EF6",
      default: false
    },
    update: {
      type: "boolean",
      required: false,
      description: "\u53EA\u6DFB\u52A0\u5DF2\u8DDF\u8E2A\u7684\u6587\u4EF6",
      default: false
    },
    dryRun: {
      type: "boolean",
      required: false,
      description: "\u5E72\u8FD0\u884C\uFF0C\u53EA\u663E\u793A\u5C06\u8981\u6DFB\u52A0\u7684\u6587\u4EF6",
      default: false
    },
    skipConfirmation: {
      type: "boolean",
      required: false,
      description: "\u8DF3\u8FC7\u7528\u6237\u786E\u8BA4\u76F4\u63A5\u6267\u884C",
      default: false
    },
    riskLevel: {
      type: "string",
      required: false,
      description: "\u98CE\u9669\u7EA7\u522B\uFF1Asafe, moderate, high, critical",
      default: "safe"
    }
  };
  /**
   * 预处理参数
   */
  async preprocessParameters(params) {
    const { files } = params;
    if (files) {
      const fileList = files.split(/\s+/).filter((f) => f.trim());
      for (const file of fileList) {
        if (file.includes("..") || file.startsWith("/")) {
          throw new Error(`\u4E0D\u5B89\u5168\u7684\u6587\u4EF6\u8DEF\u5F84: ${file}`);
        }
      }
      if (fileList.length === 0) {
        throw new Error("\u6CA1\u6709\u6307\u5B9A\u6709\u6548\u7684\u6587\u4EF6\u8DEF\u5F84");
      }
    }
    return params;
  }
  /**
   * 构建 Git add 命令
   */
  async buildCommand(params) {
    const { files, all, update, dryRun } = params;
    let command = "git add";
    if (dryRun) {
      command += " --dry-run";
    }
    if (all) {
      command += " -A";
    } else if (update) {
      command += " -u";
    } else if (files) {
      const fileList = files.split(/\s+/).filter((f) => f.trim());
      command += ` ${fileList.join(" ")}`;
    } else {
      command += " .";
    }
    return command;
  }
  /**
   * 获取确认选项
   */
  getConfirmationOptions(params) {
    const baseOptions = super.getConfirmationOptions(params);
    return {
      ...baseOptions,
      riskLevel: "safe" /* SAFE */,
      confirmMessage: params.dryRun ? "\u6267\u884C\u5E72\u8FD0\u884C\u9884\u89C8\u8981\u6DFB\u52A0\u7684\u6587\u4EF6\uFF1F" : "\u662F\u5426\u6DFB\u52A0\u8FD9\u4E9B\u6587\u4EF6\u5230\u6682\u5B58\u533A\uFF1F"
    };
  }
  /**
   * 预检查命令
   */
  async preCheckCommand(command, workingDirectory, _params) {
    try {
      await execAsync2("git rev-parse --git-dir", { cwd: workingDirectory });
      return { valid: true };
    } catch (error) {
      if (error.message.includes("not a git repository")) {
        return {
          valid: false,
          message: "\u5F53\u524D\u76EE\u5F55\u4E0D\u662F Git \u4ED3\u5E93",
          suggestions: [
            {
              command: "git init",
              description: "\u521D\u59CB\u5316 Git \u4ED3\u5E93",
              riskLevel: "safe" /* SAFE */
            }
          ]
        };
      }
      return {
        valid: false,
        message: `Git \u9884\u68C0\u67E5\u5931\u8D25: ${error.message}`
      };
    }
  }
  /**
   * 获取执行描述
   */
  getExecutionDescription(params) {
    const { files, all, update, dryRun } = params;
    let description = "";
    if (dryRun) {
      description += "\u9884\u89C8\u8981\u6DFB\u52A0\u7684\u6587\u4EF6";
    } else if (all) {
      description += "\u6DFB\u52A0\u6240\u6709\u4FEE\u6539\u7684\u6587\u4EF6";
    } else if (update) {
      description += "\u6DFB\u52A0\u6240\u6709\u5DF2\u8DDF\u8E2A\u7684\u6587\u4EF6";
    } else if (files) {
      description += `\u6DFB\u52A0\u6307\u5B9A\u6587\u4EF6: ${files}`;
    } else {
      description += "\u6DFB\u52A0\u5F53\u524D\u76EE\u5F55\u4E0B\u6240\u6709\u6587\u4EF6";
    }
    return description;
  }
  /**
   * 获取执行预览
   */
  async getExecutionPreview(command, workingDirectory, _params) {
    try {
      const { stdout: statusOutput } = await execAsync2("git status --porcelain", {
        cwd: workingDirectory,
        timeout: 5e3
      });
      if (!statusOutput.trim()) {
        return "\u6CA1\u6709\u9700\u8981\u6DFB\u52A0\u7684\u6587\u4EF6";
      }
      let preview = "\u5F85\u6DFB\u52A0\u7684\u6587\u4EF6:\n";
      const lines = statusOutput.split("\n").filter((line) => line.trim());
      for (const line of lines) {
        const status = line.substring(0, 2);
        const file = line.substring(3);
        if (status[1] !== " ") {
          let statusText = "";
          if (status[1] === "M") statusText = "\u4FEE\u6539";
          else if (status.includes("?")) statusText = "\u65B0\u6587\u4EF6";
          else if (status[1] === "D") statusText = "\u5220\u9664";
          else statusText = "\u5176\u4ED6";
          preview += `  ${statusText}: ${file}
`;
        }
      }
      return preview || "\u6CA1\u6709\u672A\u6682\u5B58\u7684\u6587\u4EF6\u9700\u8981\u6DFB\u52A0";
    } catch (error) {
      return "\u65E0\u6CD5\u83B7\u53D6\u9884\u89C8\u4FE1\u606F";
    }
  }
  /**
   * 后处理结果
   */
  async postProcessResult(result, params) {
    const output = result.stdout.trim();
    if (params.dryRun) {
      const lines = output.split("\n").filter((line) => line.trim());
      const wouldAdd = lines.map((line) => line.replace(/^add\s+/, ""));
      return {
        type: "dry-run",
        wouldAdd,
        fileCount: wouldAdd.length,
        message: `\u5C06\u8981\u6DFB\u52A0 ${wouldAdd.length} \u4E2A\u6587\u4EF6\u5230\u6682\u5B58\u533A`,
        rawOutput: output
      };
    }
    try {
      const { stdout: statusOutput } = await execAsync2("git status --porcelain", {
        cwd: params.path || ".",
        timeout: 5e3
      });
      const statusLines = statusOutput.split("\n").filter((line) => line.trim());
      const stagedFiles = statusLines.filter((line) => line[0] !== " " && line[0] !== "?").map((line) => line.substring(3));
      return {
        type: "add",
        stagedFiles,
        stagedCount: stagedFiles.length,
        message: output || `\u6210\u529F\u6DFB\u52A0\u6587\u4EF6\u5230\u6682\u5B58\u533A`,
        rawOutput: output
      };
    } catch (statusError) {
      return {
        type: "add",
        message: output || "\u6587\u4EF6\u5DF2\u6DFB\u52A0\u5230\u6682\u5B58\u533A",
        rawOutput: output
      };
    }
  }
};
var gitAdd = new GitAddTool();

// packages/core/src/tools/builtin/git/git-branch.ts
import { exec as exec3 } from "child_process";
import { promisify as promisify3 } from "util";
var execAsync3 = promisify3(exec3);
var GitBranchTool = class extends ConfirmableToolBase {
  name = "git_branch";
  description = "\u7BA1\u7406Git\u5206\u652F\uFF08\u9700\u8981\u7528\u6237\u786E\u8BA4\uFF09";
  category = "git";
  tags = ["git", "branch", "checkout", "switch"];
  parameters = {
    path: {
      type: "string",
      required: false,
      description: "\u4ED3\u5E93\u8DEF\u5F84\uFF0C\u9ED8\u8BA4\u4E3A\u5F53\u524D\u76EE\u5F55",
      default: "."
    },
    action: {
      type: "string",
      required: false,
      description: "\u64CD\u4F5C\u7C7B\u578B: list(\u5217\u51FA), create(\u521B\u5EFA), delete(\u5220\u9664), switch(\u5207\u6362)",
      default: "list"
    },
    branchName: {
      type: "string",
      required: false,
      description: "\u5206\u652F\u540D\u79F0",
      default: ""
    },
    remote: {
      type: "boolean",
      required: false,
      description: "\u5305\u542B\u8FDC\u7A0B\u5206\u652F",
      default: false
    },
    all: {
      type: "boolean",
      required: false,
      description: "\u663E\u793A\u6240\u6709\u5206\u652F\uFF08\u672C\u5730\u548C\u8FDC\u7A0B\uFF09",
      default: false
    },
    createFrom: {
      type: "string",
      required: false,
      description: "\u4ECE\u6307\u5B9A\u5206\u652F\u521B\u5EFA\u65B0\u5206\u652F",
      default: ""
    },
    skipConfirmation: {
      type: "boolean",
      required: false,
      description: "\u8DF3\u8FC7\u7528\u6237\u786E\u8BA4\u76F4\u63A5\u6267\u884C",
      default: false
    },
    riskLevel: {
      type: "string",
      required: false,
      description: "\u98CE\u9669\u7EA7\u522B\uFF1Asafe, moderate, high, critical",
      default: "moderate"
    }
  };
  /**
   * 预处理参数
   */
  async preprocessParameters(params) {
    const { action, branchName } = params;
    const validActions = ["list", "create", "delete", "switch", "checkout"];
    if (!validActions.includes(action.toLowerCase())) {
      throw new Error(`\u4E0D\u652F\u6301\u7684\u64CD\u4F5C: ${action}`);
    }
    if (["create", "delete", "switch", "checkout"].includes(action.toLowerCase()) && !branchName) {
      throw new Error(`${action}\u64CD\u4F5C\u9700\u8981\u6307\u5B9A\u5206\u652F\u540D\u79F0`);
    }
    return params;
  }
  /**
   * 构建 Git branch 命令
   */
  async buildCommand(params) {
    const { action, branchName, remote, all, createFrom } = params;
    let command = "";
    switch (action.toLowerCase()) {
      case "list":
        command = "git branch";
        if (all) {
          command += " -a";
        } else if (remote) {
          command += " -r";
        }
        break;
      case "create":
        command = `git branch ${branchName}`;
        if (createFrom) {
          command += ` ${createFrom}`;
        }
        break;
      case "delete":
        command = `git branch -d ${branchName}`;
        break;
      case "switch":
      case "checkout":
        command = `git checkout ${branchName}`;
        break;
      default:
        throw new Error(`\u4E0D\u652F\u6301\u7684\u64CD\u4F5C: ${action}`);
    }
    return command;
  }
  /**
   * 获取确认选项 - 根据操作类型设置不同的风险级别
   */
  getConfirmationOptions(params) {
    const baseOptions = super.getConfirmationOptions(params);
    let riskLevel = "safe" /* SAFE */;
    let skipConfirmation = false;
    let confirmMessage = "";
    switch (params.action.toLowerCase()) {
      case "list":
        riskLevel = "safe" /* SAFE */;
        skipConfirmation = true;
        confirmMessage = "\u67E5\u770B\u5206\u652F\u5217\u8868\uFF1F";
        break;
      case "create":
        riskLevel = "safe" /* SAFE */;
        confirmMessage = `\u521B\u5EFA\u65B0\u5206\u652F "${params.branchName}"\uFF1F`;
        break;
      case "switch":
      case "checkout":
        riskLevel = "moderate" /* MODERATE */;
        confirmMessage = `\u5207\u6362\u5230\u5206\u652F "${params.branchName}"\uFF1F`;
        break;
      case "delete":
        riskLevel = "high" /* HIGH */;
        confirmMessage = `\u26A0\uFE0F  \u5220\u9664\u5206\u652F "${params.branchName}"\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\uFF01`;
        break;
      default:
        riskLevel = "moderate" /* MODERATE */;
        confirmMessage = "\u6267\u884CGit\u5206\u652F\u64CD\u4F5C\uFF1F";
    }
    return {
      ...baseOptions,
      riskLevel,
      skipConfirmation: skipConfirmation || baseOptions.skipConfirmation,
      confirmMessage
    };
  }
  /**
   * 预检查命令
   */
  async preCheckCommand(_command, workingDirectory, params) {
    try {
      await execAsync3("git rev-parse --git-dir", { cwd: workingDirectory });
      if (["switch", "checkout"].includes(params.action.toLowerCase())) {
        try {
          const { stdout } = await execAsync3("git branch -a", { cwd: workingDirectory });
          const branches = stdout.split("\n").map((line) => line.trim().replace(/^\*?\s*/, ""));
          const branchExists = branches.some(
            (branch) => branch === params.branchName || branch.includes(`/${params.branchName}`)
          );
          if (!branchExists) {
            return {
              valid: false,
              message: `\u5206\u652F "${params.branchName}" \u4E0D\u5B58\u5728`,
              suggestions: [
                {
                  command: await this.buildCommand({ ...params, action: "create" }),
                  description: `\u521B\u5EFA\u65B0\u5206\u652F "${params.branchName}"`,
                  riskLevel: "safe" /* SAFE */
                }
              ]
            };
          }
        } catch (error) {
        }
      }
      return { valid: true };
    } catch (error) {
      if (error.message.includes("not a git repository")) {
        return {
          valid: false,
          message: "\u5F53\u524D\u76EE\u5F55\u4E0D\u662F Git \u4ED3\u5E93",
          suggestions: [
            {
              command: "git init",
              description: "\u521D\u59CB\u5316 Git \u4ED3\u5E93",
              riskLevel: "safe" /* SAFE */
            }
          ]
        };
      }
      return {
        valid: false,
        message: `Git \u9884\u68C0\u67E5\u5931\u8D25: ${error.message}`
      };
    }
  }
  /**
   * 获取执行描述
   */
  getExecutionDescription(params) {
    const { action, branchName, createFrom } = params;
    switch (action.toLowerCase()) {
      case "list":
        return "\u67E5\u770BGit\u5206\u652F\u5217\u8868";
      case "create":
        return `\u521B\u5EFA\u65B0\u5206\u652F: ${branchName}${createFrom ? ` (\u4ECE ${createFrom})` : ""}`;
      case "delete":
        return `\u5220\u9664\u5206\u652F: ${branchName}`;
      case "switch":
      case "checkout":
        return `\u5207\u6362\u5230\u5206\u652F: ${branchName}`;
      default:
        return `Git\u5206\u652F\u64CD\u4F5C: ${action}`;
    }
  }
  /**
   * 获取执行预览
   */
  async getExecutionPreview(_command, workingDirectory, params) {
    var _a;
    if (params.action.toLowerCase() === "list") {
      return "\u5C06\u663E\u793A\u5206\u652F\u5217\u8868";
    }
    try {
      const { stdout } = await execAsync3("git branch", { cwd: workingDirectory });
      const currentBranch = (_a = stdout.split("\n").find((line) => line.startsWith("*"))) == null ? void 0 : _a.trim().substring(2);
      let preview = `\u5F53\u524D\u5206\u652F: ${currentBranch || "\u672A\u77E5"}
`;
      switch (params.action.toLowerCase()) {
        case "create":
          preview += `\u5C06\u521B\u5EFA\u65B0\u5206\u652F: ${params.branchName}`;
          break;
        case "delete":
          preview += `\u26A0\uFE0F  \u5C06\u5220\u9664\u5206\u652F: ${params.branchName}`;
          break;
        case "switch":
        case "checkout":
          preview += `\u5C06\u5207\u6362\u5230\u5206\u652F: ${params.branchName}`;
          break;
      }
      return preview;
    } catch (error) {
      return "\u65E0\u6CD5\u83B7\u53D6\u9884\u89C8\u4FE1\u606F";
    }
  }
  /**
   * 后处理结果
   */
  async postProcessResult(result, params) {
    var _a;
    const output = result.stdout.trim();
    if (params.action === "list") {
      const lines = output.split("\n").filter((line) => line.trim());
      const branches = lines.map((line) => {
        const trimmed = line.trim();
        const isCurrent = trimmed.startsWith("*");
        const isRemote = trimmed.includes("remotes/");
        let name = trimmed.replace(/^\*?\s*/, "");
        if (isRemote) {
          name = name.replace("remotes/", "");
        }
        return {
          name,
          isCurrent,
          isRemote,
          fullName: trimmed.replace(/^\*?\s*/, "")
        };
      });
      return {
        type: "list",
        branches,
        currentBranch: ((_a = branches.find((b) => b.isCurrent)) == null ? void 0 : _a.name) || "",
        totalBranches: branches.length,
        localBranches: branches.filter((b) => !b.isRemote).length,
        remoteBranches: branches.filter((b) => b.isRemote).length,
        rawOutput: output
      };
    } else {
      const processedResult = {
        type: params.action,
        message: output || result.stderr,
        rawOutput: output
      };
      if (params.action === "create") {
        processedResult.createdBranch = params.branchName;
      } else if (params.action === "delete") {
        processedResult.deletedBranch = params.branchName;
      } else if (params.action === "switch" || params.action === "checkout") {
        processedResult.switchedTo = params.branchName;
      }
      return processedResult;
    }
  }
};
var gitBranch = new GitBranchTool();

// packages/core/src/tools/builtin/git/git-diff.ts
import { exec as exec4 } from "child_process";
import { promisify as promisify4 } from "util";
var execAsync4 = promisify4(exec4);
var GitDiffTool = class extends ConfirmableToolBase {
  name = "git_diff";
  description = "\u67E5\u770BGit\u6587\u4EF6\u5DEE\u5F02";
  category = "git";
  tags = ["git", "diff", "changes", "comparison"];
  parameters = {
    path: {
      type: "string",
      required: false,
      description: "\u4ED3\u5E93\u8DEF\u5F84\uFF0C\u9ED8\u8BA4\u4E3A\u5F53\u524D\u76EE\u5F55",
      default: "."
    },
    file: {
      type: "string",
      required: false,
      description: "\u6307\u5B9A\u6587\u4EF6\u8DEF\u5F84",
      default: ""
    },
    staged: {
      type: "boolean",
      required: false,
      description: "\u67E5\u770B\u6682\u5B58\u533A\u7684\u5DEE\u5F02",
      default: false
    },
    cached: {
      type: "boolean",
      required: false,
      description: "\u67E5\u770B\u5DF2\u6682\u5B58\u6587\u4EF6\u7684\u5DEE\u5F02\uFF08\u540Cstaged\uFF09",
      default: false
    },
    nameOnly: {
      type: "boolean",
      required: false,
      description: "\u53EA\u663E\u793A\u6587\u4EF6\u540D",
      default: false
    },
    stat: {
      type: "boolean",
      required: false,
      description: "\u663E\u793A\u7EDF\u8BA1\u4FE1\u606F",
      default: false
    },
    commit1: {
      type: "string",
      required: false,
      description: "\u7B2C\u4E00\u4E2A\u63D0\u4EA4hash/\u5206\u652F\u540D",
      default: ""
    },
    commit2: {
      type: "string",
      required: false,
      description: "\u7B2C\u4E8C\u4E2A\u63D0\u4EA4hash/\u5206\u652F\u540D",
      default: ""
    },
    skipConfirmation: {
      type: "boolean",
      required: false,
      description: "\u8DF3\u8FC7\u7528\u6237\u786E\u8BA4\u76F4\u63A5\u6267\u884C",
      default: true
      // 默认跳过确认，因为是只读操作
    }
  };
  /**
   * 构建 Git diff 命令
   */
  async buildCommand(params) {
    const { file, staged, cached, nameOnly, stat: stat2, commit1, commit2 } = params;
    let command = "git diff";
    if (staged || cached) {
      command += " --staged";
    }
    if (nameOnly) {
      command += " --name-only";
    } else if (stat2) {
      command += " --stat";
    }
    if (commit1 && commit2) {
      command += ` ${commit1}..${commit2}`;
    } else if (commit1) {
      command += ` ${commit1}`;
    }
    if (file) {
      command += ` -- ${file}`;
    }
    return command;
  }
  /**
   * 获取确认选项 - 只读操作默认跳过确认
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getConfirmationOptions(params) {
    return {
      skipConfirmation: true,
      // 只读操作，默认跳过确认
      riskLevel: "safe" /* SAFE */,
      showPreview: false,
      timeout: 15e3
    };
  }
  /**
   * 预检查命令
   */
  async preCheckCommand(_command, workingDirectory, _params) {
    try {
      await execAsync4("git rev-parse --git-dir", { cwd: workingDirectory });
      return { valid: true };
    } catch (error) {
      if (error.message.includes("not a git repository")) {
        return {
          valid: false,
          message: "\u5F53\u524D\u76EE\u5F55\u4E0D\u662F Git \u4ED3\u5E93",
          suggestions: [
            {
              command: "git init",
              description: "\u521D\u59CB\u5316 Git \u4ED3\u5E93",
              riskLevel: "safe" /* SAFE */
            }
          ]
        };
      }
      return {
        valid: false,
        message: `Git \u9884\u68C0\u67E5\u5931\u8D25: ${error.message}`
      };
    }
  }
  /**
   * 获取执行描述
   */
  getExecutionDescription(params) {
    const { file, staged, cached, commit1, commit2 } = params;
    let description = "\u67E5\u770BGit\u5DEE\u5F02";
    if (file) {
      description += ` - \u6587\u4EF6: ${file}`;
    }
    if (staged || cached) {
      description += " (\u6682\u5B58\u533A)";
    }
    if (commit1 && commit2) {
      description += ` (${commit1}..${commit2})`;
    } else if (commit1) {
      description += ` (\u4E0E ${commit1} \u6BD4\u8F83)`;
    }
    return description;
  }
  /**
   * 后处理结果
   */
  async postProcessResult(result, params) {
    const output = result.stdout.trim();
    const processedResult = {
      rawOutput: output
    };
    if (output) {
      if (params.nameOnly) {
        processedResult.files = output.split("\n").filter((line) => line.trim());
        processedResult.fileCount = processedResult.files.length;
        processedResult.type = "nameOnly";
      } else if (params.stat) {
        const lines = output.split("\n");
        const files = [];
        let insertions = 0;
        let deletions = 0;
        for (const line of lines) {
          if (line.includes("|")) {
            const parts = line.trim().split("|");
            if (parts.length >= 2) {
              const filename = parts[0].trim();
              const changes = parts[1].trim();
              files.push({ filename, changes });
            }
          } else if (line.includes("insertion") || line.includes("deletion")) {
            const insertionMatch = line.match(/(\d+) insertion/);
            if (insertionMatch) insertions = parseInt(insertionMatch[1]);
            const deletionMatch = line.match(/(\d+) deletion/);
            if (deletionMatch) deletions = parseInt(deletionMatch[1]);
          }
        }
        processedResult.type = "stat";
        processedResult.files = files;
        processedResult.summary = {
          fileCount: files.length,
          insertions,
          deletions,
          totalChanges: insertions + deletions
        };
      } else {
        processedResult.type = "diff";
        processedResult.diff = output;
        const lines = output.split("\n");
        const addedLines = lines.filter((line) => line.startsWith("+")).length;
        const deletedLines = lines.filter((line) => line.startsWith("-")).length;
        const modifiedFiles = /* @__PURE__ */ new Set();
        lines.forEach((line) => {
          if (line.startsWith("diff --git")) {
            const match = line.match(/diff --git a\/(.+) b\/(.+)/);
            if (match) {
              modifiedFiles.add(match[1]);
            }
          }
        });
        processedResult.summary = {
          modifiedFiles: Array.from(modifiedFiles),
          fileCount: modifiedFiles.size,
          addedLines,
          deletedLines
        };
      }
      processedResult.hasChanges = true;
    } else {
      processedResult.type = "empty";
      processedResult.message = "\u6CA1\u6709\u53D1\u73B0\u5DEE\u5F02";
      processedResult.hasChanges = false;
    }
    return processedResult;
  }
};
var gitDiff = new GitDiffTool();

// packages/core/src/tools/builtin/git/git-log.ts
import { exec as exec5 } from "child_process";
import { promisify as promisify5 } from "util";
var execAsync5 = promisify5(exec5);
var GitLogTool = class extends ConfirmableToolBase {
  name = "git_log";
  description = "\u67E5\u770BGit\u63D0\u4EA4\u5386\u53F2";
  category = "git";
  tags = ["git", "log", "history", "commits"];
  parameters = {
    path: {
      type: "string",
      required: false,
      description: "\u4ED3\u5E93\u8DEF\u5F84\uFF0C\u9ED8\u8BA4\u4E3A\u5F53\u524D\u76EE\u5F55",
      default: "."
    },
    limit: {
      type: "number",
      required: false,
      description: "\u663E\u793A\u7684\u63D0\u4EA4\u6570\u91CF\u9650\u5236",
      default: 10
    },
    oneline: {
      type: "boolean",
      required: false,
      description: "\u6BCF\u4E2A\u63D0\u4EA4\u663E\u793A\u4E00\u884C",
      default: false
    },
    graph: {
      type: "boolean",
      required: false,
      description: "\u663E\u793A\u5206\u652F\u56FE\u5F62",
      default: false
    },
    author: {
      type: "string",
      required: false,
      description: "\u6309\u4F5C\u8005\u8FC7\u6EE4\u63D0\u4EA4",
      default: ""
    },
    since: {
      type: "string",
      required: false,
      description: '\u663E\u793A\u6307\u5B9A\u65E5\u671F\u4E4B\u540E\u7684\u63D0\u4EA4 (\u5982: "2023-01-01", "1 week ago")',
      default: ""
    },
    until: {
      type: "string",
      required: false,
      description: "\u663E\u793A\u6307\u5B9A\u65E5\u671F\u4E4B\u524D\u7684\u63D0\u4EA4",
      default: ""
    },
    skipConfirmation: {
      type: "boolean",
      required: false,
      description: "\u8DF3\u8FC7\u7528\u6237\u786E\u8BA4\u76F4\u63A5\u6267\u884C",
      default: true
      // 默认跳过确认，因为是只读操作
    }
  };
  /**
   * 构建 Git log 命令
   */
  async buildCommand(params) {
    const { limit, oneline, graph, author, since, until } = params;
    let command = "git log";
    if (limit > 0) {
      command += ` -${limit}`;
    }
    if (oneline) {
      command += " --oneline";
    } else {
      command += ' --pretty=format:"%h|%an|%ae|%ad|%s" --date=iso';
    }
    if (graph) {
      command += " --graph";
    }
    if (author) {
      command += ` --author="${author}"`;
    }
    if (since) {
      command += ` --since="${since}"`;
    }
    if (until) {
      command += ` --until="${until}"`;
    }
    return command;
  }
  /**
   * 获取确认选项 - 只读操作默认跳过确认
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getConfirmationOptions(params) {
    return {
      skipConfirmation: true,
      // 只读操作，默认跳过确认
      riskLevel: "safe" /* SAFE */,
      showPreview: false,
      timeout: 15e3
    };
  }
  /**
   * 预检查命令
   */
  async preCheckCommand(_command, workingDirectory, _params) {
    try {
      await execAsync5("git rev-parse --git-dir", { cwd: workingDirectory });
      return { valid: true };
    } catch (error) {
      if (error.message.includes("not a git repository")) {
        return {
          valid: false,
          message: "\u5F53\u524D\u76EE\u5F55\u4E0D\u662F Git \u4ED3\u5E93",
          suggestions: [
            {
              command: "git init",
              description: "\u521D\u59CB\u5316 Git \u4ED3\u5E93",
              riskLevel: "safe" /* SAFE */
            }
          ]
        };
      }
      return {
        valid: false,
        message: `Git \u9884\u68C0\u67E5\u5931\u8D25: ${error.message}`
      };
    }
  }
  /**
   * 获取执行描述
   */
  getExecutionDescription(params) {
    const { limit, author, since, until, oneline, graph } = params;
    let description = `\u67E5\u770BGit\u63D0\u4EA4\u5386\u53F2 (\u6700\u591A${limit}\u6761)`;
    if (author) {
      description += ` - \u4F5C\u8005: ${author}`;
    }
    if (since) {
      description += ` - \u4ECE: ${since}`;
    }
    if (until) {
      description += ` - \u5230: ${until}`;
    }
    if (oneline) {
      description += " (\u7B80\u6D01\u6A21\u5F0F)";
    }
    if (graph) {
      description += " (\u56FE\u5F62\u6A21\u5F0F)";
    }
    return description;
  }
  /**
   * 后处理结果
   */
  async postProcessResult(result, params) {
    const output = result.stdout.trim();
    const processedResult = {
      rawOutput: output
    };
    if (output) {
      const lines = output.split("\n");
      if (params.oneline) {
        processedResult.type = "oneline";
        processedResult.commits = lines.map((line) => {
          const spaceIndex = line.indexOf(" ");
          return {
            hash: line.substring(0, spaceIndex),
            message: line.substring(spaceIndex + 1)
          };
        });
      } else if (!params.graph) {
        processedResult.type = "detailed";
        processedResult.commits = lines.map((line) => {
          const parts = line.split("|");
          return {
            hash: parts[0],
            author: parts[1],
            email: parts[2],
            date: parts[3],
            message: parts[4]
          };
        });
      } else {
        processedResult.type = "graph";
        processedResult.output = output;
      }
      processedResult.totalCommits = lines.length;
    } else {
      processedResult.type = "empty";
      processedResult.commits = [];
      processedResult.totalCommits = 0;
      processedResult.message = "\u6CA1\u6709\u627E\u5230\u63D0\u4EA4\u8BB0\u5F55";
    }
    return processedResult;
  }
};
var gitLog = new GitLogTool();

// packages/core/src/tools/builtin/git/git-smart-commit.ts
import { exec as exec6 } from "child_process";
import { promisify as promisify6 } from "util";
var execAsync6 = promisify6(exec6);
var GitSmartCommitTool = class extends ConfirmableToolBase {
  name = "git_smart_commit";
  description = "\u667A\u80FD\u5206\u6790Git\u53D8\u66F4\u5185\u5BB9\uFF0C\u4F7F\u7528LLM\u751F\u6210\u5408\u9002\u7684\u63D0\u4EA4\u4FE1\u606F\u5E76\u6267\u884C\u63D0\u4EA4";
  category = "git";
  version = "1.0.0";
  author = "Agent CLI";
  tags = ["git", "commit", "smart", "llm", "auto"];
  parameters = {
    path: {
      type: "string",
      required: false,
      description: "\u4ED3\u5E93\u8DEF\u5F84\uFF0C\u9ED8\u8BA4\u4E3A\u5F53\u524D\u76EE\u5F55",
      default: "."
    },
    autoAdd: {
      type: "boolean",
      required: false,
      description: "\u662F\u5426\u81EA\u52A8\u6DFB\u52A0\u6240\u6709\u4FEE\u6539\u7684\u6587\u4EF6\u5230\u6682\u5B58\u533A",
      default: true
    },
    dryRun: {
      type: "boolean",
      required: false,
      description: "\u5E72\u8FD0\u884C\uFF0C\u53EA\u5206\u6790\u5E76\u751F\u6210\u63D0\u4EA4\u4FE1\u606F\uFF0C\u4E0D\u5B9E\u9645\u63D0\u4EA4",
      default: false
    },
    llmAnalysis: {
      type: "string",
      required: false,
      description: "LLM\u5206\u6790\u7684\u53D8\u66F4\u5185\u5BB9\uFF08\u7531Agent\u81EA\u52A8\u586B\u5145\uFF09",
      default: ""
    },
    skipConfirmation: {
      type: "boolean",
      required: false,
      description: "\u8DF3\u8FC7\u7528\u6237\u786E\u8BA4\uFF08\u4EC5\u5728\u81EA\u52A8\u5316\u573A\u666F\u4E0B\u4F7F\u7528\uFF09",
      default: false
    }
  };
  async buildCommand(params) {
    const { llmAnalysis } = params;
    if (!llmAnalysis) {
      throw new Error("\u7F3A\u5C11LLM\u5206\u6790\u7ED3\u679C\uFF0C\u65E0\u6CD5\u751F\u6210\u63D0\u4EA4\u4FE1\u606F");
    }
    const commitMessage = llmAnalysis.trim();
    return `git commit -m "${commitMessage.replace(/"/g, '\\"')}"`;
  }
  /**
   * 生成 Git 变更分析提示
   */
  async generateGitAnalysisPrompt(workingDirectory) {
    try {
      const { stdout: statusOutput } = await execAsync6("git status --porcelain", {
        cwd: workingDirectory
      });
      let diffOutput = "";
      try {
        const { stdout: diff } = await execAsync6("git diff --cached HEAD", {
          cwd: workingDirectory
        });
        diffOutput = diff;
        if (!diffOutput.trim()) {
          const { stdout: workingDiff } = await execAsync6("git diff HEAD", {
            cwd: workingDirectory
          });
          diffOutput = workingDiff;
        }
      } catch {
        diffOutput = "\u65E0\u6CD5\u83B7\u53D6\u8BE6\u7EC6\u5DEE\u5F02\u4FE1\u606F";
      }
      const changedFiles = statusOutput.split("\n").filter((line) => line.trim()).map((line) => {
        const status = line.substring(0, 2);
        const fileName = line.substring(3);
        return { status: status.trim(), fileName };
      });
      const prompt = `\u8BF7\u5206\u6790\u4EE5\u4E0B Git \u53D8\u66F4\u5185\u5BB9\uFF0C\u751F\u6210\u4E00\u4E2A\u7B80\u6D01\u3001\u7B26\u5408 Conventional Commits \u89C4\u8303\u7684\u63D0\u4EA4\u4FE1\u606F\u3002

\u53D8\u66F4\u6587\u4EF6:
${changedFiles.map((f) => `  ${f.status} ${f.fileName}`).join("\n")}

\u4EE3\u7801\u5DEE\u5F02:
${diffOutput.length > 2e3 ? diffOutput.substring(0, 2e3) + "\n...(\u5DEE\u5F02\u5185\u5BB9\u5DF2\u622A\u53D6)" : diffOutput}

\u8BF7\u751F\u6210\u4E00\u4E2A\u7B26\u5408\u4EE5\u4E0B\u89C4\u8303\u7684\u63D0\u4EA4\u4FE1\u606F\uFF1A
- \u683C\u5F0F\uFF1A<type>(<scope>): <description>
- type\uFF1Afeat/fix/docs/style/refactor/test/chore \u7B49
- scope\uFF1A\u53EF\u9009\uFF0C\u5F71\u54CD\u7684\u6A21\u5757\u6216\u529F\u80FD
- description\uFF1A\u7B80\u6D01\u63CF\u8FF0\u53D8\u66F4\u5185\u5BB9

\u8981\u6C42\uFF1A
1. \u53EA\u8FD4\u56DE\u63D0\u4EA4\u4FE1\u606F\uFF0C\u4E0D\u8981\u5176\u4ED6\u8BF4\u660E\u6587\u5B57
2. \u63D0\u4EA4\u4FE1\u606F\u5E94\u8BE5\u7B80\u6D01\u660E\u4E86\uFF0C\u4E0D\u8D85\u8FC7 80 \u4E2A\u5B57\u7B26
3. \u7528\u4E2D\u6587\u63CF\u8FF0\uFF0C\u9664\u975E\u662F\u82F1\u6587\u9879\u76EE
4. \u5982\u679C\u6709\u591A\u4E2A\u4E0D\u76F8\u5173\u7684\u53D8\u66F4\uFF0C\u9009\u62E9\u6700\u4E3B\u8981\u7684\u53D8\u66F4\u4F5C\u4E3A\u63D0\u4EA4\u4FE1\u606F\u4E3B\u9898

\u63D0\u4EA4\u4FE1\u606F\uFF1A`;
      return prompt;
    } catch (error) {
      return `\u8BF7\u4E3A\u4EE5\u4E0B Git \u53D8\u66F4\u751F\u6210\u5408\u9002\u7684\u63D0\u4EA4\u4FE1\u606F\u3002\u7531\u4E8E\u65E0\u6CD5\u83B7\u53D6\u8BE6\u7EC6\u7684\u53D8\u66F4\u4FE1\u606F\uFF08${error.message}\uFF09\uFF0C\u8BF7\u751F\u6210\u4E00\u4E2A\u901A\u7528\u7684\u63D0\u4EA4\u4FE1\u606F\u3002\u8981\u6C42\u4F7F\u7528 Conventional Commits \u683C\u5F0F\uFF1A<type>: <description>`;
    }
  }
  getConfirmationOptions(params) {
    const { dryRun, autoAdd } = params;
    return {
      skipConfirmation: params.skipConfirmation || dryRun,
      riskLevel: autoAdd ? "moderate" /* MODERATE */ : "safe" /* SAFE */,
      confirmMessage: dryRun ? "\u662F\u5426\u9884\u89C8\u63D0\u4EA4\u4FE1\u606F\uFF1F" : "\u662F\u5426\u6267\u884C\u667A\u80FD\u63D0\u4EA4\uFF1F",
      showPreview: true
    };
  }
  async preCheckCommand(command, workingDirectory, params) {
    const { autoAdd, llmAnalysis } = params;
    try {
      await execAsync6("git rev-parse --git-dir", { cwd: workingDirectory });
    } catch {
      return {
        valid: false,
        message: "\u5F53\u524D\u76EE\u5F55\u4E0D\u662FGit\u4ED3\u5E93",
        suggestions: [
          {
            command: "git init",
            description: "\u521D\u59CB\u5316Git\u4ED3\u5E93",
            riskLevel: "moderate" /* MODERATE */
          }
        ]
      };
    }
    const { stdout: statusOutput } = await execAsync6("git status --porcelain", {
      cwd: workingDirectory
    });
    if (!statusOutput.trim() && !autoAdd) {
      return {
        valid: false,
        message: "\u6CA1\u6709\u53D8\u66F4\u9700\u8981\u63D0\u4EA4",
        suggestions: [
          {
            command: "git status",
            description: "\u67E5\u770B\u4ED3\u5E93\u72B6\u6001",
            riskLevel: "safe" /* SAFE */
          }
        ]
      };
    }
    if (llmAnalysis) {
      return { valid: true };
    }
    return { valid: true };
  }
  getExecutionDescription(params) {
    const { autoAdd, dryRun, llmAnalysis } = params;
    if (dryRun) {
      return `\u9884\u89C8\u6A21\u5F0F - \u751F\u6210\u63D0\u4EA4\u4FE1\u606F: "${llmAnalysis}"`;
    }
    return autoAdd ? `\u81EA\u52A8\u6DFB\u52A0\u6587\u4EF6\u5E76\u63D0\u4EA4: "${llmAnalysis}"` : `\u63D0\u4EA4\u6682\u5B58\u533A\u53D8\u66F4: "${llmAnalysis}"`;
  }
  async getExecutionPreview(command, workingDirectory, params) {
    const { autoAdd } = params;
    try {
      if (autoAdd) {
        const { stdout: statusOutput } = await execAsync6("git status --porcelain", {
          cwd: workingDirectory
        });
        if (statusOutput.trim()) {
          await execAsync6("git add -A", { cwd: workingDirectory });
        }
      }
      const { stdout: diffNameOnly } = await execAsync6("git diff --cached --name-only", {
        cwd: workingDirectory
      });
      const { stdout: diffStat } = await execAsync6("git diff --cached --stat", {
        cwd: workingDirectory
      });
      const changedFiles = diffNameOnly.trim().split("\n").filter((f) => f.trim());
      if (changedFiles.length === 0) {
        return "\u6682\u5B58\u533A\u6CA1\u6709\u53D8\u66F4\u6587\u4EF6";
      }
      return `\u5C06\u8981\u63D0\u4EA4\u7684\u6587\u4EF6:
${changedFiles.map((f) => `  - ${f}`).join("\n")}

\u53D8\u66F4\u7EDF\u8BA1:
${diffStat}`;
    } catch (error) {
      return `\u9884\u89C8\u4FE1\u606F\u83B7\u53D6\u5931\u8D25: ${error.message}`;
    }
  }
  /**
   * 重写执行方法，处理特殊的 need_llm_analysis 错误
   */
  async execute(params) {
    const { llmAnalysis, path: path6 = "." } = params;
    if (!llmAnalysis) {
      try {
        const analysisPrompt = await this.generateGitAnalysisPrompt(path6);
        return {
          success: false,
          error: "need_llm_analysis",
          data: {
            needsLLMAnalysis: true,
            analysisPrompt
          }
        };
      } catch (error) {
        return {
          success: false,
          error: `\u751F\u6210\u5206\u6790\u63D0\u793A\u5931\u8D25: ${error.message}`
        };
      }
    }
    try {
      const result = await super.execute(params);
      return result;
    } catch (error) {
      return {
        success: false,
        error: `Git smart commit failed: ${error.message}`
      };
    }
  }
  async executeCommand(command, workingDirectory, options, params) {
    const { autoAdd, dryRun, llmAnalysis } = params;
    try {
      if (autoAdd && !dryRun) {
        const { stdout: statusOutput } = await execAsync6("git status --porcelain", {
          cwd: workingDirectory
        });
        if (statusOutput.trim()) {
          await execAsync6("git add -A", { cwd: workingDirectory });
          console.log("\u{1F4E6} \u5DF2\u81EA\u52A8\u6DFB\u52A0\u6240\u6709\u53D8\u66F4\u6587\u4EF6\u5230\u6682\u5B58\u533A");
        }
      }
      const { stdout: diffNameOnly } = await execAsync6("git diff --cached --name-only", {
        cwd: workingDirectory
      });
      const { stdout: diffStat } = await execAsync6("git diff --cached --stat", {
        cwd: workingDirectory
      });
      const changedFiles = diffNameOnly.trim().split("\n").filter((f) => f.trim());
      if (dryRun) {
        return {
          success: true,
          command,
          workingDirectory,
          data: {
            commitMessage: llmAnalysis,
            changedFiles,
            diffStat: diffStat.trim(),
            previewMode: true,
            wouldCommit: true
          }
        };
      }
      if (changedFiles.length === 0) {
        return {
          success: false,
          error: "\u6682\u5B58\u533A\u6CA1\u6709\u53D8\u66F4\uFF0C\u8BF7\u5148\u4F7F\u7528git add\u6DFB\u52A0\u6587\u4EF6"
        };
      }
      const result = await super.executeCommand(command, workingDirectory, options, params);
      if (result.success) {
        const output = result.stdout || "";
        const lines = output.split("\n");
        let commitHash = "";
        let commitSummary = "";
        for (const line of lines) {
          if (line.includes("[") && line.includes("]")) {
            const match = line.match(/\[([^\]]+)\]\s*(.+)/);
            if (match) {
              commitHash = match[1];
              commitSummary = match[2];
            }
          }
        }
        let filesChanged = 0;
        let insertions = 0;
        let deletions = 0;
        const statsLine = lines.find(
          (line) => line.includes("file") && (line.includes("insertion") || line.includes("deletion"))
        );
        if (statsLine) {
          const fileMatch = statsLine.match(/(\d+)\s+file/);
          if (fileMatch) filesChanged = parseInt(fileMatch[1]);
          const insertMatch = statsLine.match(/(\d+)\s+insertion/);
          if (insertMatch) insertions = parseInt(insertMatch[1]);
          const deleteMatch = statsLine.match(/(\d+)\s+deletion/);
          if (deleteMatch) deletions = parseInt(deleteMatch[1]);
        }
        result.data = {
          commitMessage: llmAnalysis,
          commitHash,
          commitSummary,
          changedFiles,
          statistics: {
            filesChanged,
            insertions,
            deletions
          },
          smartGenerated: true,
          rawOutput: output
        };
      }
      return result;
    } catch (error) {
      return {
        success: false,
        error: `Git smart commit failed: ${error.message}`,
        command,
        workingDirectory
      };
    }
  }
};
var gitSmartCommit = new GitSmartCommitTool();

// packages/core/src/tools/builtin/git/git-status.ts
import { exec as exec7 } from "child_process";
import { promisify as promisify7 } from "util";
var execAsync7 = promisify7(exec7);
var GitStatusTool = class extends ConfirmableToolBase {
  name = "git_status";
  description = "\u67E5\u770BGit\u4ED3\u5E93\u7684\u5F53\u524D\u72B6\u6001";
  category = "git";
  tags = ["git", "status", "repository"];
  parameters = {
    path: {
      type: "string",
      required: false,
      description: "\u4ED3\u5E93\u8DEF\u5F84\uFF0C\u9ED8\u8BA4\u4E3A\u5F53\u524D\u76EE\u5F55",
      default: "."
    },
    porcelain: {
      type: "boolean",
      required: false,
      description: "\u4F7F\u7528\u673A\u5668\u53EF\u8BFB\u7684\u683C\u5F0F",
      default: false
    },
    short: {
      type: "boolean",
      required: false,
      description: "\u663E\u793A\u7B80\u77ED\u683C\u5F0F",
      default: false
    },
    skipConfirmation: {
      type: "boolean",
      required: false,
      description: "\u8DF3\u8FC7\u7528\u6237\u786E\u8BA4\u76F4\u63A5\u6267\u884C",
      default: true
      // 默认跳过确认，因为是只读操作
    }
  };
  /**
   * 构建 Git status 命令
   */
  async buildCommand(params) {
    const { porcelain, short } = params;
    let command = "git status";
    if (porcelain) {
      command += " --porcelain";
    } else if (short) {
      command += " --short";
    }
    return command;
  }
  /**
   * 获取确认选项 - 只读操作默认跳过确认
   */
  getConfirmationOptions(params) {
    return {
      skipConfirmation: true,
      // 只读操作，默认跳过确认
      riskLevel: "safe" /* SAFE */,
      showPreview: false,
      timeout: 1e4
    };
  }
  /**
   * 预检查命令
   */
  async preCheckCommand(_command, workingDirectory, _params) {
    try {
      await execAsync7("git rev-parse --git-dir", { cwd: workingDirectory });
      return { valid: true };
    } catch (error) {
      if (error.message.includes("not a git repository")) {
        return {
          valid: false,
          message: "\u5F53\u524D\u76EE\u5F55\u4E0D\u662F Git \u4ED3\u5E93",
          suggestions: [
            {
              command: "git init",
              description: "\u521D\u59CB\u5316 Git \u4ED3\u5E93",
              riskLevel: "safe" /* SAFE */
            }
          ]
        };
      }
      const gitError = ErrorFactory.createNotFoundError(
        "Git\u4ED3\u5E93",
        workingDirectory,
        {
          context: { workingDirectory, error: error.message },
          retryable: false,
          suggestions: [
            "\u68C0\u67E5\u5F53\u524D\u76EE\u5F55\u662F\u5426\u4E3AGit\u4ED3\u5E93",
            "\u8FD0\u884Cgit init\u521D\u59CB\u5316\u4ED3\u5E93",
            "\u786E\u8BA4Git\u5DF2\u6B63\u786E\u5B89\u88C5"
          ]
        }
      );
      globalErrorMonitor.monitor(gitError);
      return {
        valid: false,
        message: `Git \u9884\u68C0\u67E5\u5931\u8D25: ${error.message}`
      };
    }
  }
  /**
   * 获取执行描述
   */
  getExecutionDescription(params) {
    const { porcelain, short } = params;
    if (porcelain) {
      return "\u83B7\u53D6Git\u72B6\u6001\uFF08\u673A\u5668\u53EF\u8BFB\u683C\u5F0F\uFF09";
    } else if (short) {
      return "\u83B7\u53D6Git\u72B6\u6001\uFF08\u7B80\u77ED\u683C\u5F0F\uFF09";
    } else {
      return "\u83B7\u53D6Git\u72B6\u6001\uFF08\u6807\u51C6\u683C\u5F0F\uFF09";
    }
  }
  /**
   * 后处理结果
   */
  async postProcessResult(result, params) {
    const output = result.stdout.trim();
    const lines = output.split("\n").filter((line) => line.trim());
    const processedResult = {
      rawOutput: output
    };
    if (params.porcelain || params.short) {
      const files = lines.map((line) => {
        const status = line.substring(0, 2);
        const filename = line.substring(3);
        return {
          status,
          filename,
          staged: status[0] !== " " && status[0] !== "?",
          modified: status[1] !== " ",
          untracked: status === "??"
        };
      });
      processedResult.files = files;
      processedResult.summary = {
        total: files.length,
        staged: files.filter((f) => f.staged).length,
        modified: files.filter((f) => f.modified).length,
        untracked: files.filter((f) => f.untracked).length
      };
    } else {
      processedResult.output = output;
      const hasChanges = output.includes("Changes to be committed") || output.includes("Changes not staged") || output.includes("Untracked files");
      processedResult.hasChanges = hasChanges;
      processedResult.isClean = output.includes("nothing to commit, working tree clean");
    }
    return processedResult;
  }
};
var gitStatus = new GitStatusTool();

// packages/core/src/tools/builtin/smart/smart-code-review.ts
import { promises as fs3 } from "fs";
import { extname as extname2, resolve as resolve3 } from "path";
var smartCodeReview = {
  name: "smart_code_review",
  description: "\u667A\u80FD\u5206\u6790\u4EE3\u7801\u8D28\u91CF\uFF0C\u4F7F\u7528LLM\u63D0\u4F9B\u8BE6\u7EC6\u7684\u5BA1\u67E5\u62A5\u544A\u548C\u6539\u8FDB\u5EFA\u8BAE",
  category: "smart",
  version: "1.0.0",
  author: "Agent CLI",
  tags: ["smart", "code", "review", "llm", "analysis"],
  parameters: {
    path: {
      type: "string",
      required: true,
      description: "\u8981\u5BA1\u67E5\u7684\u4EE3\u7801\u6587\u4EF6\u8DEF\u5F84"
    },
    language: {
      type: "string",
      required: false,
      description: "\u7F16\u7A0B\u8BED\u8A00\uFF08\u81EA\u52A8\u68C0\u6D4B\u6216\u624B\u52A8\u6307\u5B9A\uFF09",
      default: "auto"
    },
    reviewType: {
      type: "string",
      required: false,
      description: "\u5BA1\u67E5\u7C7B\u578B",
      enum: ["full", "security", "performance", "style", "maintainability"],
      default: "full"
    },
    maxFileSize: {
      type: "number",
      required: false,
      description: "\u6700\u5927\u6587\u4EF6\u5927\u5C0F\uFF08\u5B57\u8282\uFF09",
      default: 100 * 1024
      // 100KB
    },
    llmAnalysis: {
      type: "string",
      required: false,
      description: "LLM\u5206\u6790\u7ED3\u679C\uFF08\u7531Agent\u81EA\u52A8\u586B\u5145\uFF09",
      default: ""
    }
  },
  async execute(parameters) {
    const {
      path: path6,
      language = "auto",
      reviewType = "full",
      maxFileSize = 100 * 1024,
      llmAnalysis = ""
    } = parameters;
    try {
      const resolvedPath = resolve3(path6);
      const stats = await fs3.stat(resolvedPath);
      if (!stats.isFile()) {
        throw new Error("\u6307\u5B9A\u8DEF\u5F84\u4E0D\u662F\u6587\u4EF6");
      }
      if (stats.size > maxFileSize) {
        throw new Error(`\u6587\u4EF6\u592A\u5927 (${stats.size} \u5B57\u8282)\uFF0C\u8D85\u8FC7\u9650\u5236 (${maxFileSize} \u5B57\u8282)`);
      }
      const content = await fs3.readFile(resolvedPath, "utf8");
      const detectedLanguage = language === "auto" ? detectLanguage(resolvedPath) : language;
      const codeStats = analyzeCodeStats(content);
      const analysisPrompt = buildAnalysisPrompt(content, detectedLanguage, reviewType, codeStats);
      if (!llmAnalysis) {
        return {
          success: false,
          error: "need_llm_analysis",
          data: {
            needsLLMAnalysis: true,
            analysisPrompt,
            fileInfo: {
              path: resolvedPath,
              language: detectedLanguage,
              size: stats.size,
              lines: codeStats.totalLines,
              reviewType
            }
          }
        };
      }
      const reviewReport = parseLLMAnalysis(llmAnalysis);
      const finalReport = {
        fileInfo: {
          path: resolvedPath,
          language: detectedLanguage,
          size: stats.size,
          modified: stats.mtime,
          reviewType,
          reviewedAt: (/* @__PURE__ */ new Date()).toISOString()
        },
        codeStats,
        analysis: reviewReport,
        smartGenerated: true
      };
      return {
        success: true,
        data: finalReport
      };
    } catch (error) {
      return {
        success: false,
        error: `Smart code review failed: ${error.message}`,
        data: null
      };
    }
  }
};
function detectLanguage(filePath) {
  const ext = extname2(filePath).toLowerCase();
  const languageMap = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".go": "go",
    ".rs": "rust",
    ".php": "php",
    ".rb": "ruby",
    ".swift": "swift",
    ".kt": "kotlin",
    ".scala": "scala",
    ".dart": "dart",
    ".sh": "bash",
    ".sql": "sql",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".xml": "xml"
  };
  return languageMap[ext] || "unknown";
}
function analyzeCodeStats(content) {
  const lines = content.split("\n");
  const totalLines = lines.length;
  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      blankLines++;
    } else if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
      commentLines++;
    } else {
      codeLines++;
    }
  }
  return {
    totalLines,
    codeLines,
    commentLines,
    blankLines,
    commentRatio: commentLines / totalLines,
    avgLineLength: content.length / totalLines
  };
}
function buildAnalysisPrompt(content, language, reviewType, stats) {
  const reviewFocus = getReviewFocus(reviewType);
  const truncatedContent = content.length > 3e3 ? content.substring(0, 3e3) + "\n... (\u4EE3\u7801\u5DF2\u622A\u53D6\uFF0C\u5171" + stats.totalLines + "\u884C)" : content;
  return `\u8BF7\u5BF9\u4EE5\u4E0B${language}\u4EE3\u7801\u8FDB\u884C\u4E13\u4E1A\u7684\u4EE3\u7801\u5BA1\u67E5\uFF0C\u91CD\u70B9\u5173\u6CE8${reviewFocus}\u3002

\u4EE3\u7801\u7EDF\u8BA1\u4FE1\u606F:
- \u603B\u884C\u6570: ${stats.totalLines}
- \u4EE3\u7801\u884C\u6570: ${stats.codeLines}
- \u6CE8\u91CA\u884C\u6570: ${stats.commentLines}
- \u6CE8\u91CA\u7387: ${(stats.commentRatio * 100).toFixed(1)}%

\u4EE3\u7801\u5185\u5BB9:
\`\`\`${language}
${truncatedContent}
\`\`\`

\u8BF7\u4ECE\u4EE5\u4E0B\u65B9\u9762\u8FDB\u884C\u5206\u6790\u5E76\u63D0\u4F9BJSON\u683C\u5F0F\u7684\u62A5\u544A\uFF1A

{
  "overallScore": \u8BC4\u5206(1-10),
  "summary": "\u603B\u4F53\u8BC4\u4EF7\u548C\u4E3B\u8981\u95EE\u9898\u6982\u8FF0",
  "issues": [
    {
      "type": "\u95EE\u9898\u7C7B\u578B(security/performance/style/maintainability/bug)",
      "severity": "\u4E25\u91CD\u7EA7\u522B(high/medium/low)",
      "description": "\u95EE\u9898\u63CF\u8FF0",
      "suggestion": "\u6539\u8FDB\u5EFA\u8BAE",
      "lineRange": "\u76F8\u5173\u884C\u6570\u8303\u56F4(\u5982\u679C\u9002\u7528)"
    }
  ],
  "strengths": ["\u4EE3\u7801\u4F18\u70B9\u5217\u8868"],
  "recommendations": ["\u5177\u4F53\u6539\u8FDB\u5EFA\u8BAE\u5217\u8868"],
  "securityConcerns": ["\u5B89\u5168\u95EE\u9898\u5217\u8868"],
  "performanceNotes": ["\u6027\u80FD\u76F8\u5173\u5EFA\u8BAE"],
  "maintainabilityScore": \u53EF\u7EF4\u62A4\u6027\u8BC4\u5206(1-10)
}

\u8BF7\u786E\u4FDD\u5206\u6790\u8BE6\u7EC6\u3001\u51C6\u786E\uFF0C\u5E76\u63D0\u4F9B\u53EF\u64CD\u4F5C\u7684\u6539\u8FDB\u5EFA\u8BAE\u3002`;
}
function getReviewFocus(reviewType) {
  const focusMap = {
    full: "\u4EE3\u7801\u8D28\u91CF\u3001\u6027\u80FD\u3001\u5B89\u5168\u6027\u548C\u53EF\u7EF4\u62A4\u6027",
    security: "\u5B89\u5168\u6F0F\u6D1E\u548C\u6F5C\u5728\u98CE\u9669",
    performance: "\u6027\u80FD\u4F18\u5316\u548C\u6267\u884C\u6548\u7387",
    style: "\u4EE3\u7801\u98CE\u683C\u548C\u89C4\u8303\u6027",
    maintainability: "\u53EF\u7EF4\u62A4\u6027\u548C\u4EE3\u7801\u7ED3\u6784"
  };
  return focusMap[reviewType] || "\u4EE3\u7801\u8D28\u91CF";
}
function parseLLMAnalysis(llmAnalysis) {
  try {
    const cleanAnalysis = llmAnalysis.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleanAnalysis);
    return {
      overallScore: parsed.overallScore || 0,
      summary: parsed.summary || "\u5206\u6790\u7ED3\u679C\u89E3\u6790\u5931\u8D25",
      issues: parsed.issues || [],
      strengths: parsed.strengths || [],
      recommendations: parsed.recommendations || [],
      securityConcerns: parsed.securityConcerns || [],
      performanceNotes: parsed.performanceNotes || [],
      maintainabilityScore: parsed.maintainabilityScore || 0
    };
  } catch (error) {
    return {
      overallScore: 0,
      summary: "\u5206\u6790\u7ED3\u679C\u683C\u5F0F\u9519\u8BEF\uFF0C\u4F46\u5305\u542B\u4EE5\u4E0B\u5185\u5BB9",
      rawAnalysis: llmAnalysis,
      issues: [],
      strengths: [],
      recommendations: [],
      securityConcerns: [],
      performanceNotes: [],
      maintainabilityScore: 0
    };
  }
}

// packages/core/src/tools/builtin/smart/smart-doc-generator.ts
import { promises as fs4 } from "fs";
import { dirname as dirname3, extname as extname3, resolve as resolve4 } from "path";
var smartDocGenerator = {
  name: "smart_doc_generator",
  description: "\u667A\u80FD\u5206\u6790\u4EE3\u7801\u6587\u4EF6\uFF0C\u4F7F\u7528LLM\u751F\u6210API\u6587\u6863\u3001README\u6216\u6280\u672F\u8BF4\u660E",
  category: "smart",
  version: "1.0.0",
  author: "Agent CLI",
  tags: ["smart", "documentation", "api", "readme", "llm"],
  parameters: {
    sourcePath: {
      type: "string",
      required: true,
      description: "\u8981\u5206\u6790\u7684\u6E90\u4EE3\u7801\u6587\u4EF6\u6216\u76EE\u5F55\u8DEF\u5F84"
    },
    outputPath: {
      type: "string",
      required: false,
      description: "\u8F93\u51FA\u6587\u6863\u8DEF\u5F84\uFF08\u9ED8\u8BA4\u4E3A\u6E90\u6587\u4EF6\u540C\u7EA7\u76EE\u5F55\u4E0B\u7684README.md\uFF09"
    },
    docType: {
      type: "string",
      required: false,
      description: "\u6587\u6863\u7C7B\u578B",
      enum: ["api", "readme", "guide", "technical", "auto"],
      default: "auto"
    },
    language: {
      type: "string",
      required: false,
      description: "\u7F16\u7A0B\u8BED\u8A00\uFF08\u81EA\u52A8\u68C0\u6D4B\u6216\u624B\u52A8\u6307\u5B9A\uFF09",
      default: "auto"
    },
    includeExamples: {
      type: "boolean",
      required: false,
      description: "\u662F\u5426\u5305\u542B\u4F7F\u7528\u793A\u4F8B",
      default: true
    },
    maxFileSize: {
      type: "number",
      required: false,
      description: "\u5355\u4E2A\u6587\u4EF6\u6700\u5927\u5927\u5C0F\uFF08\u5B57\u8282\uFF09",
      default: 200 * 1024
      // 200KB
    },
    overwrite: {
      type: "boolean",
      required: false,
      description: "\u662F\u5426\u8986\u76D6\u5DF2\u5B58\u5728\u7684\u6587\u6863\u6587\u4EF6",
      default: false
    },
    llmAnalysis: {
      type: "string",
      required: false,
      description: "LLM\u5206\u6790\u7ED3\u679C\uFF08\u7531Agent\u81EA\u52A8\u586B\u5145\uFF09",
      default: ""
    }
  },
  async execute(parameters) {
    const {
      sourcePath,
      outputPath,
      docType = "auto",
      language = "auto",
      includeExamples = true,
      maxFileSize = 200 * 1024,
      overwrite = false,
      llmAnalysis = ""
    } = parameters;
    try {
      const resolvedSourcePath = resolve4(sourcePath);
      const sourceStats = await fs4.stat(resolvedSourcePath);
      let codeFiles = [];
      if (sourceStats.isFile()) {
        if (sourceStats.size > maxFileSize) {
          throw new Error(`\u6587\u4EF6\u592A\u5927 (${sourceStats.size} \u5B57\u8282)\uFF0C\u8D85\u8FC7\u9650\u5236 (${maxFileSize} \u5B57\u8282)`);
        }
        const content = await fs4.readFile(resolvedSourcePath, "utf8");
        const detectedLanguage = language === "auto" ? detectLanguage2(resolvedSourcePath) : language;
        codeFiles.push({
          path: resolvedSourcePath,
          content,
          language: detectedLanguage
        });
      } else if (sourceStats.isDirectory()) {
        codeFiles = await scanCodeFiles(resolvedSourcePath, maxFileSize);
      } else {
        throw new Error("\u6E90\u8DEF\u5F84\u5FC5\u987B\u662F\u6587\u4EF6\u6216\u76EE\u5F55");
      }
      if (codeFiles.length === 0) {
        throw new Error("\u672A\u627E\u5230\u53EF\u5206\u6790\u7684\u4EE3\u7801\u6587\u4EF6");
      }
      const codeAnalysis = analyzeCodeStructure(codeFiles);
      const finalDocType = docType === "auto" ? detectDocType(codeAnalysis) : docType;
      const finalOutputPath = outputPath || generateOutputPath(resolvedSourcePath, finalDocType);
      if (!overwrite) {
        try {
          await fs4.access(finalOutputPath);
          throw new Error(`\u8F93\u51FA\u6587\u4EF6\u5DF2\u5B58\u5728: ${finalOutputPath}\uFF0C\u4F7F\u7528 overwrite: true \u5F3A\u5236\u8986\u76D6`);
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      }
      const analysisPrompt = buildDocumentationPrompt(codeAnalysis, finalDocType, includeExamples);
      if (!llmAnalysis) {
        return {
          success: false,
          error: "need_llm_analysis",
          data: {
            needsLLMAnalysis: true,
            analysisPrompt,
            sourceInfo: {
              sourcePath: resolvedSourcePath,
              outputPath: finalOutputPath,
              docType: finalDocType,
              fileCount: codeFiles.length,
              primaryLanguage: codeAnalysis.primaryLanguage
            }
          }
        };
      }
      const documentContent = processLLMDocumentation(llmAnalysis, finalDocType);
      await fs4.mkdir(dirname3(finalOutputPath), { recursive: true });
      await fs4.writeFile(finalOutputPath, documentContent, "utf8");
      const outputStats = await fs4.stat(finalOutputPath);
      const result = {
        sourceInfo: {
          path: resolvedSourcePath,
          type: sourceStats.isFile() ? "file" : "directory",
          fileCount: codeFiles.length,
          primaryLanguage: codeAnalysis.primaryLanguage
        },
        documentInfo: {
          path: finalOutputPath,
          type: finalDocType,
          size: outputStats.size,
          createdAt: outputStats.birthtime,
          includesExamples: includeExamples
        },
        analysis: codeAnalysis,
        smartGenerated: true
      };
      return {
        success: true,
        data: result
      };
    } catch (error) {
      return {
        success: false,
        error: `Smart doc generation failed: ${error.message}`,
        data: null
      };
    }
  }
};
function detectLanguage2(filePath) {
  const ext = extname3(filePath).toLowerCase();
  const languageMap = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".php": "php",
    ".rb": "ruby",
    ".swift": "swift",
    ".kt": "kotlin",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".c": "c",
    ".h": "c"
  };
  return languageMap[ext] || "unknown";
}
async function scanCodeFiles(dirPath, maxFileSize) {
  const codeFiles = [];
  const codeExtensions = [
    ".js",
    ".mjs",
    ".jsx",
    ".ts",
    ".tsx",
    ".py",
    ".java",
    ".go",
    ".rs",
    ".php",
    ".rb"
  ];
  async function scanDirectory(currentPath, depth = 0) {
    if (depth > 3) return;
    const items = await fs4.readdir(currentPath);
    for (const item of items) {
      if (item.startsWith(".")) continue;
      const itemPath = resolve4(currentPath, item);
      const itemStats = await fs4.stat(itemPath);
      if (itemStats.isDirectory()) {
        if (["node_modules", "dist", "build", ".git", "__pycache__"].includes(item)) {
          continue;
        }
        await scanDirectory(itemPath, depth + 1);
      } else if (itemStats.isFile()) {
        const ext = extname3(item).toLowerCase();
        if (codeExtensions.includes(ext) && itemStats.size <= maxFileSize) {
          try {
            const content = await fs4.readFile(itemPath, "utf8");
            const language = detectLanguage2(itemPath);
            codeFiles.push({ path: itemPath, content, language });
            if (codeFiles.length >= 20) break;
          } catch (error) {
          }
        }
      }
    }
  }
  await scanDirectory(dirPath);
  return codeFiles;
}
function analyzeCodeStructure(codeFiles) {
  var _a;
  const languages = /* @__PURE__ */ new Map();
  const functions = [];
  const classes = [];
  const exports = [];
  const imports = [];
  let totalLines = 0;
  let totalSize = 0;
  for (const file of codeFiles) {
    const { content, language } = file;
    totalLines += content.split("\n").length;
    totalSize += content.length;
    languages.set(language, (languages.get(language) || 0) + 1);
    extractCodeStructures(content, language, { functions, classes, exports, imports });
  }
  const primaryLanguage = ((_a = Array.from(languages.entries()).sort((a, b) => b[1] - a[1])[0]) == null ? void 0 : _a[0]) || "unknown";
  return {
    fileCount: codeFiles.length,
    primaryLanguage,
    languages: Object.fromEntries(languages),
    totalLines,
    totalSize,
    structures: {
      functions: Array.from(new Set(functions)).slice(0, 20),
      classes: Array.from(new Set(classes)).slice(0, 10),
      exports: Array.from(new Set(exports)).slice(0, 15),
      imports: Array.from(new Set(imports)).slice(0, 15)
    }
  };
}
function extractCodeStructures(content, language, structures) {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (language === "javascript" || language === "typescript") {
      if (trimmed.match(/^(export\s+)?(async\s+)?function\s+(\w+)/)) {
        const match = trimmed.match(/function\s+(\w+)/);
        if (match) structures.functions.push(match[1]);
      }
      if (trimmed.match(/^(export\s+)?const\s+(\w+)\s*=\s*.*=>/)) {
        const match = trimmed.match(/const\s+(\w+)/);
        if (match) structures.functions.push(match[1]);
      }
      if (trimmed.match(/^(export\s+)?class\s+(\w+)/)) {
        const match = trimmed.match(/class\s+(\w+)/);
        if (match) structures.classes.push(match[1]);
      }
      if (trimmed.startsWith("export")) {
        structures.exports.push(trimmed);
      }
      if (trimmed.startsWith("import")) {
        structures.imports.push(trimmed);
      }
    }
  }
}
function detectDocType(analysis) {
  const { structures, primaryLanguage } = analysis;
  if (structures.exports.length > 5 || structures.functions.length > 10) {
    return "api";
  }
  if (primaryLanguage === "javascript" || primaryLanguage === "typescript") {
    return "guide";
  }
  return "readme";
}
function generateOutputPath(sourcePath, docType) {
  const sourceDir = dirname3(sourcePath);
  const fileNames = {
    api: "API.md",
    readme: "README.md",
    guide: "GUIDE.md",
    technical: "TECHNICAL.md"
  };
  const fileName = fileNames[docType] || "README.md";
  return resolve4(sourceDir, fileName);
}
function buildDocumentationPrompt(analysis, docType, includeExamples) {
  const { primaryLanguage, structures, fileCount, totalLines } = analysis;
  const exampleNote = includeExamples ? "\u5E76\u5305\u542B\u5B9E\u9645\u7684\u4F7F\u7528\u793A\u4F8B" : "";
  return `\u8BF7\u4E3A\u4EE5\u4E0B${primaryLanguage}\u9879\u76EE\u751F\u6210${getDocTypeDescription(docType)}\u6587\u6863${exampleNote}\u3002

\u9879\u76EE\u5206\u6790\u4FE1\u606F:
- \u4E3B\u8981\u8BED\u8A00: ${primaryLanguage}
- \u6587\u4EF6\u6570\u91CF: ${fileCount}
- \u603B\u4EE3\u7801\u884C\u6570: ${totalLines}
- \u4E3B\u8981\u51FD\u6570: ${structures.functions.slice(0, 10).join(", ")}
- \u4E3B\u8981\u7C7B: ${structures.classes.slice(0, 5).join(", ")}
- \u5173\u952E\u5BFC\u51FA: ${structures.exports.slice(0, 5).join("; ")}

\u8BF7\u751F\u6210\u4E00\u4E2A\u4E13\u4E1A\u3001\u8BE6\u7EC6\u4E14\u7ED3\u6784\u5316\u7684${getDocTypeDescription(docType)}\u6587\u6863\uFF0C\u5305\u542B\u4EE5\u4E0B\u90E8\u5206\uFF1A

1. **\u9879\u76EE\u6982\u8FF0** - \u7B80\u660E\u627C\u8981\u5730\u63CF\u8FF0\u9879\u76EE\u529F\u80FD\u548C\u7528\u9014
2. **\u5B89\u88C5\u8BF4\u660E** - \u5982\u4F55\u5B89\u88C5\u548C\u914D\u7F6E\u9879\u76EE
3. **\u5FEB\u901F\u5F00\u59CB** - \u57FA\u672C\u4F7F\u7528\u65B9\u6CD5\u548C\u5165\u95E8\u793A\u4F8B
4. **API\u6587\u6863** - \u4E3B\u8981\u51FD\u6570\u3001\u7C7B\u548C\u65B9\u6CD5\u7684\u8BE6\u7EC6\u8BF4\u660E\uFF08\u5982\u679C\u9002\u7528\uFF09
5. **\u4F7F\u7528\u793A\u4F8B** - \u5B9E\u9645\u7684\u4EE3\u7801\u793A\u4F8B\u5C55\u793A\u5982\u4F55\u4F7F\u7528${includeExamples ? "\uFF08\u5FC5\u987B\u5305\u542B\uFF09" : ""}
6. **\u914D\u7F6E\u9009\u9879** - \u91CD\u8981\u7684\u914D\u7F6E\u53C2\u6570\u548C\u9009\u9879
7. **\u6545\u969C\u6392\u9664** - \u5E38\u89C1\u95EE\u9898\u548C\u89E3\u51B3\u65B9\u6848
8. **\u8D21\u732E\u6307\u5357** - \u5982\u4F55\u53C2\u4E0E\u9879\u76EE\u5F00\u53D1\uFF08\u5982\u679C\u9002\u7528\uFF09

\u8981\u6C42\uFF1A
- \u4F7F\u7528Markdown\u683C\u5F0F
- \u4EE3\u7801\u793A\u4F8B\u8981\u5B8C\u6574\u4E14\u53EF\u8FD0\u884C
- \u8BED\u8A00\u7B80\u6D01\u6E05\u6670\uFF0C\u9002\u5408\u6280\u672F\u6587\u6863
- \u7ED3\u6784\u5C42\u6B21\u5206\u660E\uFF0C\u4FBF\u4E8E\u9605\u8BFB
- \u6839\u636E\u5B9E\u9645\u7684\u4EE3\u7801\u7ED3\u6784\u6765\u751F\u6210\u5185\u5BB9\uFF0C\u4E0D\u8981\u865A\u6784\u4E0D\u5B58\u5728\u7684\u529F\u80FD

\u8BF7\u76F4\u63A5\u8FD4\u56DE\u5B8C\u6574\u7684Markdown\u6587\u6863\u5185\u5BB9\u3002`;
}
function getDocTypeDescription(docType) {
  const descriptions = {
    api: "API\u53C2\u8003",
    readme: "README",
    guide: "\u7528\u6237\u6307\u5357",
    technical: "\u6280\u672F\u6587\u6863"
  };
  return descriptions[docType] || "README";
}
function processLLMDocumentation(llmAnalysis, docType) {
  let content = llmAnalysis.trim();
  content = content.replace(/^```markdown\n?|\n?```$/g, "");
  content = content.replace(/^```\n?|\n?```$/g, "");
  if (!content.startsWith("#")) {
    const title = getDocTypeDescription(docType);
    content = `# ${title}

${content}`;
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  content += `

---

*\u6B64\u6587\u6863\u7531 Agent CLI \u667A\u80FD\u751F\u6210\uFF0C\u751F\u6210\u65F6\u95F4\uFF1A${timestamp}*
`;
  return content;
}

// packages/core/src/agent/MCPComponent.ts
import { EventEmitter as EventEmitter3 } from "events";

// packages/core/src/mcp/server/MCPServer.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// packages/core/src/mcp/config/MCPConfig.ts
import { promises as fs5 } from "fs";
import path2 from "path";
import os from "os";

// packages/core/src/mcp/oauth-provider.ts
import { randomBytes as randomBytes2, createHash as createHash2 } from "crypto";
import { URLSearchParams } from "url";
import axios2 from "axios";

// packages/core/src/mcp/oauth-token-storage.ts
import { promises as fs6 } from "fs";
import path3 from "path";
import os2 from "os";
import crypto2 from "crypto";

// packages/cli/src/config/ConfigService.ts
import fs7 from "fs/promises";
import path4 from "path";
import os3 from "os";
var CONFIG_PATHS2 = {
  global: {
    userConfig: `${os3.homedir()}/.blade/config.json`,
    userConfigLegacy: `${os3.homedir()}/.blade-config.json`,
    trustedFolders: `${os3.homedir()}/.blade/trusted-folders.json`
  },
  project: {
    bladeConfig: "./.blade/settings.local.json",
    packageJson: "./package.json",
    bladeConfigRoot: "./.blade/config.json"
  },
  env: {
    configFile: process.env.BLADE_CONFIG_FILE || ""
  }
};
var ConfigService = class _ConfigService {
  static instance;
  config = null;
  constructor() {
  }
  static getInstance() {
    if (!_ConfigService.instance) {
      _ConfigService.instance = new _ConfigService();
    }
    return _ConfigService.instance;
  }
  /**
   * 初始化配置服务
   */
  async initialize() {
    try {
      const layers = await this.loadAllConfigLayers();
      const result = createConfig(layers, {
        validate: true,
        throwOnError: false
      });
      if (result.errors.length > 0) {
        console.warn("\u914D\u7F6E\u9A8C\u8BC1\u8B66\u544A:", result.errors.join(", "));
      }
      this.config = result.config;
      return this.config;
    } catch (error) {
      console.error("\u914D\u7F6E\u521D\u59CB\u5316\u5931\u8D25:", error);
      const defaultResult = createConfig({}, { validate: false });
      this.config = defaultResult.config;
      return this.config;
    }
  }
  /**
   * 获取当前配置
   */
  getConfig() {
    if (!this.config) {
      throw new Error("\u914D\u7F6E\u5C1A\u672A\u521D\u59CB\u5316\uFF0C\u8BF7\u5148\u8C03\u7528 initialize() \u65B9\u6CD5");
    }
    return this.config;
  }
  /**
   * 重新加载配置
   */
  async reload() {
    this.config = null;
    return this.initialize();
  }
  /**
   * 加载所有配置层
   */
  async loadAllConfigLayers() {
    const layers = {};
    try {
      layers.global = await this.loadGlobalConfig();
      layers.env = this.loadEnvConfig();
      layers.user = await this.loadUserConfig();
      layers.project = await this.loadProjectConfig();
    } catch (error) {
      console.warn("\u914D\u7F6E\u52A0\u8F7D\u8FC7\u7A0B\u4E2D\u51FA\u73B0\u9519\u8BEF:", error);
    }
    return layers;
  }
  /**
   * 加载全局配置
   */
  async loadGlobalConfig() {
    return {
      auth: {
        apiKey: "",
        baseUrl: "https://apis.iflow.cn/v1",
        modelName: "Qwen3-Coder",
        searchApiKey: ""
      },
      ui: {
        theme: "GitHub",
        hideTips: false,
        hideBanner: false
      },
      security: {
        sandbox: "docker",
        trustedFolders: [],
        allowedOperations: ["read", "write", "execute"]
      }
      // 其他默认配置...
    };
  }
  /**
   * 加载环境变量配置
   */
  loadEnvConfig() {
    const envConfig = {};
    if (process.env.BLADE_API_KEY) {
      envConfig.auth = { ...envConfig.auth || {}, apiKey: process.env.BLADE_API_KEY };
    }
    if (process.env.BLADE_BASE_URL) {
      envConfig.auth = { ...envConfig.auth || {}, baseUrl: process.env.BLADE_BASE_URL };
    }
    if (process.env.BLADE_MODEL) {
      envConfig.auth = { ...envConfig.auth || {}, modelName: process.env.BLADE_MODEL };
    }
    if (process.env.BLADE_THEME) {
      envConfig.ui = { ...envConfig.ui || {}, theme: process.env.BLADE_THEME };
    }
    return envConfig;
  }
  /**
   * 加载用户配置
   */
  async loadUserConfig() {
    try {
      const userConfigPath = CONFIG_PATHS2.global.userConfig;
      const configContent = await fs7.readFile(userConfigPath, "utf-8");
      return JSON.parse(configContent);
    } catch (error) {
      return {};
    }
  }
  /**
   * 加载项目配置
   */
  async loadProjectConfig() {
    try {
      const projectConfigPath = CONFIG_PATHS2.project.bladeConfig;
      const configContent = await fs7.readFile(projectConfigPath, "utf-8");
      return JSON.parse(configContent);
    } catch (error) {
      return {};
    }
  }
  /**
   * 保存用户配置
   */
  async saveUserConfig(config) {
    try {
      const userConfigPath = CONFIG_PATHS2.global.userConfig;
      const configDir = path4.dirname(userConfigPath);
      await fs7.mkdir(configDir, { recursive: true });
      await fs7.writeFile(userConfigPath, JSON.stringify(config, null, 2), "utf-8");
      await this.reload();
    } catch (error) {
      console.error("\u4FDD\u5B58\u7528\u6237\u914D\u7F6E\u5931\u8D25:", error);
      throw error;
    }
  }
  /**
   * 更新配置
   */
  async updateConfig(updates) {
    return this.reload();
  }
};

// packages/cli/src/services/CommandOrchestrator.ts
var CommandOrchestrator = class _CommandOrchestrator {
  static instance;
  agent = null;
  llmManager = null;
  contextComponent = null;
  toolComponent = null;
  configService;
  constructor() {
    this.configService = ConfigService.getInstance();
  }
  static getInstance() {
    if (!_CommandOrchestrator.instance) {
      _CommandOrchestrator.instance = new _CommandOrchestrator();
    }
    return _CommandOrchestrator.instance;
  }
  /**
   * 初始化编排器
   */
  async initialize() {
    try {
      const config = this.configService.getConfig();
      this.agent = new Agent({
        llm: {
          provider: config.auth.apiKey ? "qwen" : "volcengine",
          apiKey: config.auth.apiKey,
          baseUrl: config.auth.baseUrl,
          modelName: config.auth.modelName
        }
      });
      await this.agent.init();
      this.llmManager = this.agent.getLLMManager();
      this.contextComponent = this.agent.getContextComponent();
      this.toolComponent = this.agent.getToolComponent();
    } catch (error) {
      console.error("\u547D\u4EE4\u7F16\u6392\u5668\u521D\u59CB\u5316\u5931\u8D25:", error);
      throw error;
    }
  }
  /**
   * 执行斜杠命令
   */
  async executeSlashCommand(command, args = []) {
    try {
      if (!this.agent) {
        await this.initialize();
      }
      switch (command.toLowerCase()) {
        case "help":
          return await this.executeHelpCommand();
        case "clear":
          return await this.executeClearCommand();
        case "status":
          return await this.executeStatusCommand();
        case "config":
          return await this.executeConfigCommand(args);
        case "tools":
          return await this.executeToolsCommand();
        default:
          return {
            success: false,
            error: `\u672A\u77E5\u547D\u4EE4: /${command}`
          };
      }
    } catch (error) {
      return {
        success: false,
        error: `\u6267\u884C\u547D\u4EE4\u5931\u8D25: ${error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"}`
      };
    }
  }
  /**
   * 执行自然语言命令
   */
  async executeNaturalLanguage(input) {
    try {
      if (!this.agent) {
        await this.initialize();
      }
      const response = await this.agent.chat(input);
      return {
        success: true,
        output: response,
        metadata: {
          type: "naturalLanguage",
          timestamp: Date.now()
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `\u5904\u7406\u81EA\u7136\u8BED\u8A00\u5931\u8D25: ${error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"}`
      };
    }
  }
  /**
   * 帮助命令
   */
  async executeHelpCommand() {
    const helpText = `
\u{1F680} Blade AI \u52A9\u624B - \u53EF\u7528\u547D\u4EE4

\u{1F4CB} \u659C\u6760\u547D\u4EE4:
  /help     - \u663E\u793A\u5E2E\u52A9\u4FE1\u606F
  /clear    - \u6E05\u9664\u4F1A\u8BDD\u5386\u53F2
  /status   - \u663E\u793A\u7CFB\u7EDF\u72B6\u6001
  /config   - \u914D\u7F6E\u7BA1\u7406
  /tools    - \u67E5\u770B\u53EF\u7528\u5DE5\u5177

\u{1F4AC} \u81EA\u7136\u8BED\u8A00:
  \u76F4\u63A5\u8F93\u5165\u95EE\u9898\u6216\u6307\u4EE4\uFF0C\u4F8B\u5982:
  "\u5E2E\u6211\u5199\u4E00\u4E2A\u51FD\u6570"
  "review \u8FD9\u4E2A\u6587\u4EF6"
  "\u89E3\u91CA\u8FD9\u6BB5\u4EE3\u7801"

\u{1F3AF} \u793A\u4F8B:
  /config get apiKey
  "\u5E2E\u6211\u4F18\u5316\u8FD9\u6BB5\u4EE3\u7801"
  "review src/main.ts"
    `;
    return {
      success: true,
      output: helpText
    };
  }
  /**
   * 清除命令
   */
  async executeClearCommand() {
    if (this.contextComponent) {
      this.contextComponent.clear();
    }
    return {
      success: true,
      output: "\u2705 \u4F1A\u8BDD\u5386\u53F2\u5DF2\u6E05\u9664"
    };
  }
  /**
   * 状态命令
   */
  async executeStatusCommand() {
    const config = this.configService.getConfig();
    const status = {
      agent: this.agent ? "\u5DF2\u521D\u59CB\u5316" : "\u672A\u521D\u59CB\u5316",
      llm: config.auth.modelName || "\u672A\u8BBE\u7F6E",
      tools: this.toolComponent ? this.toolComponent.getToolCount() : 0,
      context: this.contextComponent ? this.contextComponent.getMessageCount() : 0
    };
    const statusText = `
\u{1F4CA} \u7CFB\u7EDF\u72B6\u6001:
  \u{1F916} Agent: ${status.agent}
  \u{1F9E0} LLM: ${status.llm}
  \u{1F6E0}\uFE0F  \u5DE5\u5177: ${status.tools} \u4E2A
  \u{1F4AC} \u4E0A\u4E0B\u6587: ${status.context} \u6761\u6D88\u606F
    `;
    return {
      success: true,
      output: statusText
    };
  }
  /**
   * 配置命令
   */
  async executeConfigCommand(args) {
    if (args.length === 0) {
      return {
        success: false,
        error: "\u4F7F\u7528\u65B9\u6CD5: /config <get|set> <key> [value]"
      };
    }
    const [action, key, value] = args;
    switch (action.toLowerCase()) {
      case "get":
        return await this.handleConfigGet(key);
      case "set":
        return await this.handleConfigSet(key, value);
      default:
        return {
          success: false,
          error: `\u672A\u77E5\u64CD\u4F5C: ${action}`
        };
    }
  }
  /**
   * 获取配置
   */
  async handleConfigGet(key) {
    const config = this.configService.getConfig();
    const value = this.getNestedConfigValue(config, key);
    if (value === void 0) {
      return {
        success: false,
        error: `\u914D\u7F6E\u9879\u4E0D\u5B58\u5728: ${key}`
      };
    }
    return {
      success: true,
      output: `${key} = ${JSON.stringify(value, null, 2)}`
    };
  }
  /**
   * 设置配置
   */
  async handleConfigSet(key, value) {
    try {
      return {
        success: false,
        error: "\u914D\u7F6E\u8BBE\u7F6E\u529F\u80FD\u5C1A\u672A\u5B9E\u73B0"
      };
    } catch (error) {
      return {
        success: false,
        error: `\u8BBE\u7F6E\u914D\u7F6E\u5931\u8D25: ${error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"}`
      };
    }
  }
  /**
   * 工具命令
   */
  async executeToolsCommand() {
    if (!this.toolComponent) {
      return {
        success: false,
        error: "\u5DE5\u5177\u7EC4\u4EF6\u672A\u521D\u59CB\u5316"
      };
    }
    const tools = this.toolComponent.listTools();
    const toolList = tools.map(
      (tool) => `  \u2022 ${tool.name} - ${tool.description}`
    ).join("\n");
    return {
      success: true,
      output: `\u{1F6E0}\uFE0F \u53EF\u7528\u5DE5\u5177 (${tools.length} \u4E2A):
${toolList}`
    };
  }
  /**
   * 获取嵌套配置值
   */
  getNestedConfigValue(config, path6) {
    return path6.split(".").reduce((obj, key) => {
      return obj && obj[key] !== void 0 ? obj[key] : void 0;
    }, config);
  }
  /**
   * 清理资源
   */
  async cleanup() {
    if (this.agent) {
      await this.agent.destroy();
      this.agent = null;
    }
    this.llmManager = null;
    this.contextComponent = null;
    this.toolComponent = null;
  }
};

// packages/cli/src/components/ErrorBoundary.tsx
import React3 from "react";
import { Box as Box2, Text as Text2 } from "ink";
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
var ErrorBoundary2 = class extends React3.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }
  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error,
      errorInfo: null
    };
  }
  componentDidCatch(error, errorInfo) {
    this.setState({
      error,
      errorInfo
    });
    console.error("\u672A\u6355\u83B7\u7684\u9519\u8BEF:", error, errorInfo);
  }
  render() {
    var _a, _b;
    if (this.state.hasError) {
      return /* @__PURE__ */ jsxs2(Box2, { flexDirection: "column", padding: 1, borderStyle: "round", borderColor: "red", children: [
        /* @__PURE__ */ jsx3(Text2, { color: "red", children: "\u{1F4A5} \u5E94\u7528\u53D1\u751F\u9519\u8BEF" }),
        /* @__PURE__ */ jsx3(Text2, { children: " " }),
        /* @__PURE__ */ jsx3(Text2, { color: "red", children: (_a = this.state.error) == null ? void 0 : _a.message }),
        /* @__PURE__ */ jsx3(Text2, { children: " " }),
        /* @__PURE__ */ jsx3(Text2, { color: "gray", children: "\u9519\u8BEF\u8BE6\u60C5:" }),
        /* @__PURE__ */ jsx3(Text2, { color: "gray", children: (_b = this.state.error) == null ? void 0 : _b.stack }),
        /* @__PURE__ */ jsx3(Text2, { children: " " }),
        /* @__PURE__ */ jsx3(Text2, { color: "yellow", children: "\u8BF7\u91CD\u542F\u5E94\u7528\u6216\u8054\u7CFB\u5F00\u53D1\u8005" })
      ] });
    }
    return this.props.children;
  }
};

// packages/cli/src/commands/agent-llm.ts
import chalk3 from "chalk";
function agentLlmCommand(program) {
  const llmCmd = program.command("chat").description("\u{1F4AC} \u667A\u80FD\u5BF9\u8BDD").argument("[message]", "\u5BF9\u8BDD\u5185\u5BB9").option("-k, --api-key <key>", "API\u5BC6\u94A5").option("-u, --base-url <url>", "API\u57FA\u7840URL").option("-m, --model <name>", "\u6A21\u578B\u540D\u79F0").option("-s, --system <prompt>", "\u7CFB\u7EDF\u63D0\u793A\u8BCD").option("-i, --interactive", "\u4EA4\u4E92\u5F0F\u5BF9\u8BDD").option("--theme <name>", "\u754C\u9762\u4E3B\u9898 (default|dark|dracula|nord|tokyo-night|github|monokai|ayu-dark|solarized-light|solarized-dark|gruvbox|one-dark|catppuccin|rose-pine|kanagawa)").action(async (message, options) => {
    await handleChat(message, options);
  });
  llmCmd.alias("c");
}
async function handleChat(message, options) {
  try {
    const configUpdates = {};
    if (options.apiKey) configUpdates.apiKey = options.apiKey;
    if (options.baseUrl) configUpdates.baseUrl = options.baseUrl;
    if (options.model) configUpdates.modelName = options.model;
    const agent = new Agent(configUpdates);
    if (options.theme) {
      const { themeManager: themeManager2 } = await Promise.resolve().then(() => (init_themes(), themes_exports));
      themeManager2.setTheme(options.theme);
    }
    if (options.interactive || !message) {
      await interactiveChat(agent, options.system);
      return;
    }
    if (options.system) {
      const response = await agent.chatWithSystem(options.system, message);
      console.log(response);
    } else {
      const response = await agent.chat(message);
      console.log(response);
    }
  } catch (error) {
    console.error(chalk3.red(`\u274C \u8C03\u7528\u5931\u8D25: ${error.message}`));
    process.exit(1);
  }
}
async function interactiveChat(agent, systemPrompt) {
  const readline = __require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  console.log(chalk3.cyan('\u{1F680} \u542F\u52A8\u4EA4\u4E92\u5F0F\u5BF9\u8BDD (\u8F93\u5165 "exit" \u6216 "quit" \u9000\u51FA)'));
  if (systemPrompt) {
    console.log(chalk3.gray(`\u7CFB\u7EDF\u63D0\u793A\u8BCD: ${systemPrompt}`));
  }
  console.log("");
  const chatLoop = async () => {
    rl.question(chalk3.green("\u{1F464} \u4F60: "), async (input) => {
      if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
        console.log(chalk3.yellow("\u{1F44B} \u518D\u89C1!"));
        rl.close();
        return;
      }
      if (input.trim()) {
        try {
          process.stdout.write(chalk3.blue("\u{1F916} AI: "));
          const response = systemPrompt ? await agent.chatWithSystem(systemPrompt, input) : await agent.chat(input);
          console.log(response);
        } catch (error) {
          console.error(chalk3.red(`
\u274C \u8C03\u7528\u5931\u8D25: ${error.message}`));
        }
      }
      console.log("");
      chatLoop();
    });
  };
  chatLoop();
}

// packages/cli/src/config/config-manager.ts
import crypto3 from "crypto";
import { promises as fs8 } from "fs";
import os4 from "os";
import path5 from "path";
import { performance } from "perf_hooks";

// packages/cli/src/config/types.ts
var DEFAULT_CONFIG2 = {
  core: {
    debug: false,
    telemetry: true,
    autoUpdate: true,
    maxMemory: 1024 * 1024 * 1024,
    // 1GB
    timeout: 3e4,
    workingDirectory: process.cwd(),
    tempDirectory: process.env.TEMP || "/tmp"
  },
  auth: {
    apiKey: "",
    apiSecret: "",
    tokenStorage: "file",
    tokenRefreshInterval: 3600,
    providers: []
  },
  llm: {
    provider: "qwen",
    model: "qwen-turbo",
    temperature: 0.7,
    maxTokens: 4e3,
    topP: 0.9,
    topK: 50,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: true
  },
  mcp: {
    enabled: false,
    servers: [],
    autoConnect: false,
    timeout: 5e3,
    maxConnections: 5
  },
  ui: {
    theme: "default",
    fontSize: 14,
    fontFamily: "monospace",
    lineHeight: 1.4,
    showStatusBar: true,
    showNotifications: true,
    animations: true,
    shortcuts: {},
    language: "zh-CN"
  },
  tools: {
    git: {
      autoDetect: true,
      defaultBranch: "main",
      commitVerification: false
    },
    fileSystem: {
      allowedPaths: [],
      blockedPaths: [],
      maxFileSize: 10 * 1024 * 1024
      // 10MB
    },
    shell: {
      allowedCommands: [],
      blockedCommands: ["rm -rf", "format", "del"],
      timeout: 3e4
    },
    network: {
      timeout: 1e4,
      maxRetries: 3,
      userAgent: "Blade-Agent/1.0"
    }
  },
  services: {
    fileSystem: {
      watchEnabled: true,
      watchInterval: 1e3,
      indexingEnabled: true
    },
    git: {
      autoSync: false,
      syncInterval: 6e4,
      commitOnExit: false
    },
    logging: {
      level: "info",
      format: "text",
      output: "both",
      maxFiles: 5,
      maxSize: "10MB"
    },
    telemetry: {
      enabled: true,
      endpoint: "https://telemetry.blade-ai.com/api/v1/events",
      interval: 3e5,
      // 5分钟
      batchSize: 100
    }
  },
  advanced: {
    experimentalFeatures: false,
    performanceMode: "balanced",
    memoryManagement: "auto",
    gcInterval: 6e4,
    threadPool: {
      minThreads: 2,
      maxThreads: 8
    },
    cache: {
      enabled: true,
      maxSize: 100 * 1024 * 1024,
      // 100MB
      ttl: 36e5,
      // 1小时
      strategy: "lru"
    },
    security: {
      sandboxEnabled: true,
      validateInputs: true,
      rateLimiting: {
        enabled: true,
        requests: 100,
        window: 6e4
      },
      encryption: {
        algorithm: "aes-256-gcm",
        keyRotationInterval: 864e5
        // 24小时
      }
    }
  },
  privacy: {
    dataCollection: true,
    crashReporting: true,
    usageMetrics: true,
    personalizedExperience: true,
    thirdPartySharing: false
  },
  extensions: {
    enabled: true,
    directory: "./extensions",
    autoInstall: false,
    autoUpdate: true,
    trustedSources: ["https://extensions.blade-ai.com"],
    installed: []
  },
  development: {
    mode: "production",
    hotReload: false,
    debugTools: false,
    mockData: false,
    testRunner: {
      enabled: false,
      autoRun: false,
      coverage: false
    }
  },
  plugins: {
    enabled: false,
    directory: "./plugins",
    loadOrder: {
      pre: [],
      core: [],
      post: []
    },
    hooks: {}
  }
};

// packages/cli/src/config/config-manager.ts
var ConfigManager2 = class _ConfigManager {
  static instance;
  config = null;
  configStatus = null;
  locations;
  envMapping;
  migrations;
  configLoaded = false;
  configLoading = false;
  constructor() {
    this.locations = this.getConfigLocations();
    this.envMapping = this.getEnvMapping();
    this.migrations = this.getConfigMigrations();
  }
  static getInstance() {
    if (!_ConfigManager.instance) {
      _ConfigManager.instance = new _ConfigManager();
    }
    return _ConfigManager.instance;
  }
  async initialize(userConfig) {
    if (this.configLoaded) {
      return this.config;
    }
    if (this.configLoading) {
      await this.waitForConfigLoad();
      return this.config;
    }
    this.configLoading = true;
    const startTime = performance.now();
    try {
      this.config = await this.loadDefaultConfig();
      this.config = this.applyEnvVariables(this.config);
      const userConfigData = await this.loadUserConfigFile();
      if (userConfigData) {
        this.config = this.mergeConfig(this.config, userConfigData);
      }
      if (userConfig) {
        this.config = this.mergeConfig(this.config, userConfig);
      }
      this.config = await this.runMigrations(this.config);
      const { isValid: isValid2, errors, warnings } = this.validateConfig(this.config);
      this.configStatus = {
        isValid: isValid2,
        errors,
        warnings,
        loadedFrom: this.determineConfigSource(),
        lastModified: Date.now(),
        checksum: this.generateConfigChecksum(this.config)
      };
      await this.ensureConfigDirectories();
      if (isValid2) {
        await this.saveConfig(this.config);
      } else {
        console.warn("\u914D\u7F6E\u9A8C\u8BC1\u5931\u8D25\uFF0C\u4F7F\u7528\u9ED8\u8BA4\u914D\u7F6E");
        console.warn("\u9519\u8BEF\u4FE1\u606F:", errors.map((e) => e.message).join(", "));
      }
      this.configLoaded = true;
      const loadTime = performance.now() - startTime;
      if (this.config.core.debug) {
        console.log(`\u914D\u7F6E\u52A0\u8F7D\u5B8C\u6210\uFF0C\u8017\u65F6: ${loadTime.toFixed(2)}ms`);
      }
      return this.config;
    } catch (error) {
      console.error("\u914D\u7F6E\u521D\u59CB\u5316\u5931\u8D25:", error);
      this.config = this.createFallbackConfig();
      this.configLoaded = true;
      return this.config;
    } finally {
      this.configLoading = false;
    }
  }
  getConfig() {
    if (!this.configLoaded || !this.config) {
      throw new Error("\u914D\u7F6E\u5C1A\u672A\u521D\u59CB\u5316\uFF0C\u8BF7\u5148\u8C03\u7528 initialize()");
    }
    return this.config;
  }
  getConfigStatus() {
    if (!this.configStatus) {
      throw new Error("\u914D\u7F6E\u72B6\u6001\u5C1A\u672A\u521D\u59CB\u5316");
    }
    return this.configStatus;
  }
  async updateConfig(updates) {
    if (!this.config) {
      throw new Error("\u914D\u7F6E\u5C1A\u672A\u521D\u59CB\u5316");
    }
    const startTime = performance.now();
    try {
      const newConfig = this.cloneConfig(this.config);
      const mergedConfig = this.mergeConfig(newConfig, updates);
      const { isValid: isValid2, errors, warnings } = this.validateConfig(mergedConfig);
      if (isValid2) {
        this.config = mergedConfig;
        await this.saveConfig(this.config);
        this.configStatus = {
          isValid: isValid2,
          errors,
          warnings,
          loadedFrom: this.determineConfigSource(),
          lastModified: Date.now(),
          checksum: this.generateConfigChecksum(this.config)
        };
        if (this.config.core.debug) {
          const update_time = performance.now() - startTime;
          console.log(`\u914D\u7F6E\u66F4\u65B0\u5B8C\u6210\uFF0C\u8017\u65F6: ${update_time.toFixed(2)}ms`);
        }
      } else {
        console.warn("\u914D\u7F6E\u66F4\u65B0\u5931\u8D25\uFF0C\u9A8C\u8BC1\u672A\u901A\u8FC7");
        errors.forEach((error) => {
          console.warn(`\u914D\u7F6E\u9519\u8BEF: ${error.path} - ${error.message}`);
        });
      }
      return this.configStatus;
    } catch (error) {
      console.error("\u914D\u7F6E\u66F4\u65B0\u5931\u8D25:", error);
      throw error;
    }
  }
  async resetConfig() {
    try {
      await fs8.unlink(this.locations.userConfigPath);
    } catch (error) {
    }
    this.configLoaded = false;
    this.config = null;
    this.configStatus = null;
    return await this.initialize();
  }
  exportConfig() {
    if (!this.config) {
      throw new Error("\u914D\u7F6E\u5C1A\u672A\u521D\u59CB\u5316");
    }
    return JSON.stringify(this.config, null, 2);
  }
  importConfig(configJson) {
    try {
      const importedConfig = JSON.parse(configJson);
      return this.updateConfig(importedConfig);
    } catch (error) {
      throw new Error("\u914D\u7F6E\u5BFC\u5165\u5931\u8D25: " + (error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"));
    }
  }
  async loadDefaultConfig() {
    const packageJson = await this.loadPackageJson();
    return {
      version: packageJson.version || "1.0.0",
      name: packageJson.name || "blade-ai",
      description: packageJson.description || "\u667A\u80FDAI\u52A9\u624B\u547D\u4EE4\u884C\u5DE5\u5177",
      ...DEFAULT_CONFIG2
    };
  }
  async loadPackageJson() {
    try {
      const packagePath = path5.resolve(process.cwd(), "package.json");
      const content = await fs8.readFile(packagePath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      return { version: "1.0.0", name: "blade-ai", description: "\u667A\u80FDAI\u52A9\u624B\u547D\u4EE4\u884C\u5DE5\u5177" };
    }
  }
  async loadUserConfigFile() {
    var _a;
    const configPaths = [
      this.locations.userConfigPath,
      this.locations.globalConfigPath,
      this.locations.localConfigPath
    ];
    for (const configPath of configPaths) {
      try {
        if (await this.fileExists(configPath)) {
          const content = await fs8.readFile(configPath, "utf-8");
          const config = JSON.parse(content);
          if ((_a = this.config) == null ? void 0 : _a.core.debug) {
            console.log(`\u52A0\u8F7D\u914D\u7F6E\u6587\u4EF6: ${configPath}`);
          }
          return config;
        }
      } catch (error) {
        console.warn(`\u52A0\u8F7D\u914D\u7F6E\u6587\u4EF6\u5931\u8D25: ${configPath}`, error);
      }
    }
    return null;
  }
  applyEnvVariables(config) {
    var _a;
    const result = this.cloneConfig(config);
    for (const [envKey, mapping] of Object.entries(this.envMapping)) {
      const envValue = process.env[envKey];
      if (envValue !== void 0) {
        try {
          const value = this.parseEnvValue(envValue, mapping.type, mapping.default);
          this.setConfigValue(result, mapping.path, value);
          if ((_a = this.config) == null ? void 0 : _a.core.debug) {
            console.log(`\u5E94\u7528\u73AF\u5883\u53D8\u91CF: ${envKey} -> ${mapping.path} = ${value}`);
          }
        } catch (error) {
          console.warn(`\u73AF\u5883\u53D8\u91CF\u89E3\u6790\u5931\u8D25: ${envKey} = ${envValue}`);
        }
      } else if (mapping.required && mapping.default === void 0) {
        console.warn(`\u7F3A\u5C11\u5FC5\u9700\u7684\u73AF\u5883\u53D8\u91CF: ${envKey}`);
      }
    }
    return result;
  }
  parseEnvValue(rawValue, type, defaultValue) {
    if (rawValue === void 0 || rawValue === "") {
      return defaultValue;
    }
    switch (type) {
      case "string":
        return rawValue;
      case "number":
        return Number(rawValue);
      case "boolean":
        return rawValue.toLowerCase() === "true" || rawValue === "1";
      default:
        return rawValue;
    }
  }
  setConfigValue(config, path6, value) {
    const keys = path6.split(".");
    let current = config;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key];
    }
    current[keys[keys.length - 1]] = value;
  }
  mergeConfig(base, override) {
    const result = this.cloneConfig(base);
    this.deepMerge(result, override);
    return result;
  }
  deepMerge(target, source) {
    if (typeof target !== "object" || target === null || typeof source !== "object" || source === null) {
      return;
    }
    for (const key of Object.keys(source)) {
      if (source[key] === void 0 || source[key] === null) {
        continue;
      }
      if (typeof source[key] === "object" && !Array.isArray(source[key])) {
        if (!(key in target) || typeof target[key] !== "object") {
          target[key] = {};
        }
        this.deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }
  cloneConfig(config) {
    return JSON.parse(JSON.stringify(config));
  }
  validateConfig(config) {
    const errors = [];
    const warnings = [];
    if (!config.version) {
      errors.push({
        code: "MISSING_VERSION",
        message: "\u7F3A\u5C11\u7248\u672C\u4FE1\u606F",
        path: "version",
        severity: "error"
      });
    }
    if (!config.core.workingDirectory) {
      errors.push({
        code: "MISSING_WORKING_DIR",
        message: "\u7F3A\u5C11\u5DE5\u4F5C\u76EE\u5F55\u914D\u7F6E",
        path: "core.workingDirectory",
        severity: "error"
      });
    }
    if (config.tools.network.timeout <= 0) {
      errors.push({
        code: "INVALID_TIMEOUT",
        message: "\u7F51\u7EDC\u8D85\u65F6\u65F6\u95F4\u5FC5\u987B\u5927\u4E8E0",
        path: "tools.network.timeout",
        severity: "error",
        value: config.tools.network.timeout
      });
    }
    if (config.core.maxMemory <= 0) {
      errors.push({
        code: "INVALID_MAX_MEMORY",
        message: "\u6700\u5927\u5185\u5B58\u5FC5\u987B\u5927\u4E8E0",
        path: "core.maxMemory",
        severity: "error",
        value: config.core.maxMemory
      });
    }
    if (config.ui.fontSize < 8 || config.ui.fontSize > 32) {
      warnings.push({
        code: "FONT_SIZE_OUT_OF_RANGE",
        message: "\u5B57\u4F53\u5927\u5C0F\u5EFA\u8BAE\u57288-32\u4E4B\u95F4",
        path: "ui.fontSize",
        severity: "warning",
        value: config.ui.fontSize
      });
    }
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
  async runMigrations(config) {
    const result = this.cloneConfig(config);
    for (const migration of this.migrations) {
      if (config.version === migration.from) {
        console.log(`\u8FD0\u884C\u914D\u7F6E\u8FC1\u79FB: ${migration.from} -> ${migration.to}`);
        for (const change of migration.changes) {
          if (change.migrationScript) {
            try {
              change.migrationScript(result);
            } catch (error) {
              console.warn(`\u8FC1\u79FB\u811A\u672C\u6267\u884C\u5931\u8D25: ${change.path}`, error);
            }
          }
        }
        result.version = migration.to;
      }
    }
    return result;
  }
  async saveConfig(config) {
    const configPath = this.locations.userConfigPath;
    const configDir = path5.dirname(configPath);
    await fs8.mkdir(configDir, { recursive: true });
    const configJson = JSON.stringify(config, null, 2);
    await fs8.writeFile(configPath, configJson, "utf-8");
    if (config.core.debug) {
      console.log(`\u914D\u7F6E\u5DF2\u4FDD\u5B58\u5230: ${configPath}`);
    }
  }
  async ensureConfigDirectories() {
    const directories = [
      this.locations.userConfigPath,
      path5.dirname(this.locations.tempConfigPath)
    ];
    for (const dir of directories) {
      const configDir = path5.dirname(dir);
      await fs8.mkdir(configDir, { recursive: true });
    }
  }
  async fileExists(filePath) {
    try {
      await fs8.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  async waitForConfigLoad() {
    let attempts = 0;
    const maxAttempts = 100;
    const interval = 50;
    return new Promise((resolve5, reject) => {
      const checkInterval = setInterval(() => {
        if (this.configLoaded) {
          clearInterval(checkInterval);
          resolve5(void 0);
        } else if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          reject(new Error("\u7B49\u5F85\u914D\u7F6E\u52A0\u8F7D\u8D85\u65F6"));
        }
        attempts++;
      }, interval);
    });
  }
  determineConfigSource() {
    return this.locations.userConfigPath;
  }
  generateConfigChecksum(config) {
    const configString = JSON.stringify(config);
    return crypto3.createHash("sha256").update(configString).digest("hex");
  }
  createFallbackConfig() {
    console.warn("\u4F7F\u7528\u5907\u7528\u914D\u7F6E");
    return {
      version: "1.0.0",
      name: "blade-ai",
      description: "\u667A\u80FDAI\u52A9\u624B\u547D\u4EE4\u884C\u5DE5\u5177",
      ...DEFAULT_CONFIG2
    };
  }
  getConfigLocations() {
    const homeDir = os4.homedir();
    return {
      userConfigPath: path5.join(homeDir, ".blade", "config.json"),
      globalConfigPath: path5.join("/usr", "local", "etc", "blade", "config.json"),
      localConfigPath: path5.join(process.cwd(), ".blade", "config.json"),
      tempConfigPath: path5.join(os4.tmpdir(), "blade-config.json")
    };
  }
  getEnvMapping() {
    return {
      BLADE_DEBUG: {
        path: "core.debug",
        type: "boolean",
        default: false,
        description: "\u542F\u7528\u8C03\u8BD5\u6A21\u5F0F"
      },
      BLADE_API_KEY: {
        path: "auth.apiKey",
        type: "string",
        required: false,
        description: "API\u5BC6\u94A5"
      },
      BLADE_THEME: {
        path: "ui.theme",
        type: "string",
        default: "default",
        description: "UI\u4E3B\u9898"
      },
      BLADE_LANGUAGE: {
        path: "ui.language",
        type: "string",
        default: "zh-CN",
        description: "\u754C\u9762\u8BED\u8A00"
      },
      BLADE_WORKING_DIR: {
        path: "core.workingDirectory",
        type: "string",
        default: process.cwd(),
        description: "\u5DE5\u4F5C\u76EE\u5F55"
      },
      BLADE_MAX_MEMORY: {
        path: "core.maxMemory",
        type: "number",
        default: 1024 * 1024 * 1024,
        description: "\u6700\u5927\u5185\u5B58\u4F7F\u7528\u91CF"
      },
      BLADE_LLM_PROVIDER: {
        path: "llm.provider",
        type: "string",
        default: "qwen",
        description: "LLM\u63D0\u4F9B\u5546"
      },
      BLADE_LLM_MODEL: {
        path: "llm.model",
        type: "string",
        default: "qwen-turbo",
        description: "LLM\u6A21\u578B"
      },
      BLADE_TELEMETRY: {
        path: "core.telemetry",
        type: "boolean",
        default: true,
        description: "\u9065\u6D4B\u6570\u636E\u6536\u96C6"
      },
      BLADE_AUTO_UPDATE: {
        path: "core.autoUpdate",
        type: "boolean",
        default: true,
        description: "\u81EA\u52A8\u66F4\u65B0"
      }
    };
  }
  getConfigMigrations() {
    return [
      {
        from: "1.0.0",
        to: "1.1.0",
        breaking: false,
        notes: "\u6DFB\u52A0\u9065\u6D4B\u914D\u7F6E",
        changes: [
          {
            path: "telemetry",
            type: "add",
            description: "\u6DFB\u52A0\u9065\u6D4B\u914D\u7F6E",
            defaultValue: DEFAULT_CONFIG2.services.telemetry
          }
        ]
      },
      {
        from: "1.1.0",
        to: "1.2.0",
        breaking: false,
        notes: "\u6DFB\u52A0MCP\u914D\u7F6E",
        changes: [
          {
            path: "mcp",
            type: "add",
            description: "\u6DFB\u52A0MCP\u670D\u52A1\u5668\u914D\u7F6E",
            defaultValue: DEFAULT_CONFIG2.mcp
          }
        ]
      }
    ];
  }
};

// packages/cli/src/ui/components/Animation.ts
init_colors();
import chalk4 from "chalk";

// packages/cli/src/ui/components/Display.ts
init_styles();
var UIDisplay = class {
  static defaultOptions = {
    newline: true,
    indent: 0
  };
  /**
   * 格式化输出文本
   */
  static formatText(text, options = {}) {
    const opts = { ...this.defaultOptions, ...options };
    let result = text;
    if (opts.prefix) {
      result = opts.prefix + result;
    }
    if (opts.suffix) {
      result = result + opts.suffix;
    }
    if (opts.indent && opts.indent > 0) {
      const indent = " ".repeat(opts.indent);
      result = indent + result.split("\n").join("\n" + indent);
    }
    return result;
  }
  /**
   * 输出文本
   */
  static output(text, options = {}) {
    const opts = { ...this.defaultOptions, ...options };
    const formatted = this.formatText(text, opts);
    if (opts.newline) {
      console.log(formatted);
    } else {
      process.stdout.write(formatted);
    }
  }
  /**
   * 成功消息
   */
  static success(message, options) {
    const text = `${UIStyles.icon.success} ${UIStyles.status.success(message)}`;
    this.output(text, options);
  }
  /**
   * 错误消息
   */
  static error(message, options) {
    const text = `${UIStyles.icon.error} ${UIStyles.status.error(message)}`;
    this.output(text, options);
  }
  /**
   * 警告消息
   */
  static warning(message, options) {
    const text = `${UIStyles.icon.warning} ${UIStyles.status.warning(message)}`;
    this.output(text, options);
  }
  /**
   * 信息消息
   */
  static info(message, options) {
    const text = `${UIStyles.icon.info} ${UIStyles.status.info(message)}`;
    this.output(text, options);
  }
  /**
   * 静默文本
   */
  static muted(message, options) {
    const text = UIStyles.status.muted(message);
    this.output(text, options);
  }
  /**
   * 页面标题
   */
  static header(title, options) {
    const text = `${UIStyles.icon.rocket} ${UIStyles.component.header(title)}`;
    this.output(text, options);
  }
  /**
   * 节标题
   */
  static section(title, content, options) {
    const text = UIStyles.component.section(title);
    this.output(text, options);
    if (content) {
      this.output(content, { ...options, indent: 2 });
    }
  }
  /**
   * 键值对显示
   */
  static keyValue(key, value, options) {
    const text = `${UIStyles.component.label(key)}: ${UIStyles.component.value(value)}`;
    this.output(text, options);
  }
  /**
   * 代码块显示
   */
  static code(code, language, options) {
    const prefix = language ? UIStyles.status.muted(`[${language}]`) + "\n" : "";
    const text = prefix + UIStyles.component.code(code);
    this.output(text, options);
  }
  /**
   * 引用文本
   */
  static quote(text, author, options) {
    const quote = UIStyles.component.quote(`"${text}"`);
    const attribution = author ? UIStyles.status.muted(` - ${author}`) : "";
    this.output(quote + attribution, options);
  }
  /**
   * 分隔线
   */
  static separator(length = 50, double = false) {
    const line = double ? UIStyles.border.doubleLine(length) : UIStyles.border.line(length);
    this.output(line);
  }
  /**
   * 空行
   */
  static newline(count = 1) {
    for (let i = 0; i < count; i++) {
      console.log();
    }
  }
  /**
   * 清屏
   */
  static clear() {
    console.clear();
  }
  /**
   * 普通输出
   */
  static text(message, options) {
    this.output(message, options);
  }
  /**
   * 高亮文本
   */
  static highlight(message, options) {
    const text = UIStyles.semantic.highlight(message);
    this.output(text, options);
  }
  /**
   * 步骤提示
   */
  static step(step, total, message, options) {
    const stepText = UIStyles.status.info(`[${step}/${total}]`);
    const text = `${stepText} ${message}`;
    this.output(text, options);
  }
};

// packages/cli/src/ui/components/Input.ts
init_styles();
import inquirer2 from "inquirer";
var UIInput = class {
  /**
   * 文本输入
   */
  static async text(message, options = {}) {
    const answers = await inquirer2.prompt([
      {
        type: "input",
        name: "value",
        message: UIStyles.component.label(message),
        ...options
      }
    ]);
    return answers.value;
  }
  /**
   * 密码输入
   */
  static async password(message, options = {}) {
    const answers = await inquirer2.prompt([
      {
        type: "password",
        name: "value",
        message: UIStyles.component.label(message),
        mask: "*",
        ...options
      }
    ]);
    return answers.value;
  }
  /**
   * 确认输入
   */
  static async confirm(message, options = {}) {
    const answers = await inquirer2.prompt([
      {
        type: "confirm",
        name: "value",
        message: UIStyles.component.label(message),
        default: false,
        ...options
      }
    ]);
    return answers.value;
  }
  /**
   * 单选列表
   */
  static async select(message, choices, options = {}) {
    const answers = await inquirer2.prompt([
      {
        type: "list",
        name: "value",
        message: UIStyles.component.label(message),
        choices: choices.map((choice) => ({
          name: choice.name,
          value: choice.value,
          short: choice.short || choice.name,
          disabled: choice.disabled
        })),
        pageSize: 10,
        ...options
      }
    ]);
    return answers.value;
  }
  /**
   * 多选列表
   */
  static async multiSelect(message, choices, options = {}) {
    const answers = await inquirer2.prompt([
      {
        type: "checkbox",
        name: "value",
        message: UIStyles.component.label(message),
        choices: choices.map((choice) => ({
          name: choice.name,
          value: choice.value,
          checked: false,
          disabled: choice.disabled
        })),
        pageSize: 10,
        ...options
      }
    ]);
    return answers.value;
  }
  /**
   * 自动完成输入
   */
  static async autocomplete(message, source) {
    const answers = await inquirer2.prompt([
      {
        type: "autocomplete",
        name: "value",
        message: UIStyles.component.label(message),
        source
      }
      // 需要额外的插件支持
    ]);
    return answers.value;
  }
  /**
   * 数字输入
   */
  static async number(message, options = {}) {
    const { min, max, ...inputOptions } = options;
    const validate = (input) => {
      const num = parseFloat(input);
      if (isNaN(num)) {
        return "\u8BF7\u8F93\u5165\u6709\u6548\u7684\u6570\u5B57";
      }
      if (min !== void 0 && num < min) {
        return `\u6570\u5B57\u4E0D\u80FD\u5C0F\u4E8E ${min}`;
      }
      if (max !== void 0 && num > max) {
        return `\u6570\u5B57\u4E0D\u80FD\u5927\u4E8E ${max}`;
      }
      if (options.validate) {
        return options.validate(input);
      }
      return true;
    };
    const filter = (input) => {
      return parseFloat(input);
    };
    const answers = await inquirer2.prompt([
      {
        type: "input",
        name: "value",
        message: UIStyles.component.label(message),
        validate,
        filter,
        ...inputOptions
      }
    ]);
    return answers.value;
  }
  /**
   * 编辑器输入（多行文本）
   */
  static async editor(message, options = {}) {
    const answers = await inquirer2.prompt([
      {
        type: "editor",
        name: "value",
        message: UIStyles.component.label(message),
        ...options
      }
    ]);
    return answers.value;
  }
  /**
   * 原始提示符（不带样式）
   */
  static async raw(questions) {
    return inquirer2.prompt(questions);
  }
  /**
   * 等待用户按键继续
   */
  static async pressKeyToContinue(message = "\u6309\u4EFB\u610F\u952E\u7EE7\u7EED...") {
    await inquirer2.prompt([
      {
        type: "input",
        name: "continue",
        message: UIStyles.status.muted(message)
      }
    ]);
  }
  /**
   * 快速确认（带默认值）
   */
  static async quickConfirm(message, defaultValue = true) {
    return this.confirm(message, { default: defaultValue });
  }
  /**
   * 快速选择（带常用选项）
   */
  static async quickSelect(message, options, defaultIndex = 0) {
    const choices = options.map((option) => ({
      name: option,
      value: option,
      short: option
    }));
    return this.select(message, choices, {
      default: options[defaultIndex]
    });
  }
};

// packages/cli/src/ui/components/Layout.ts
init_styles();
var UILayout = class {
  /**
   * 创建页面头部
   */
  static header(title, subtitle, options = {}) {
    const opts = { width: 80, padding: 2, border: true, ...options };
    UIDisplay.newline();
    if (opts.border) {
      UIDisplay.text(UIStyles.border.doubleLine(opts.width));
    }
    const centeredTitle = this.centerText(title, opts.width);
    UIDisplay.text(UIStyles.heading.h1(centeredTitle));
    if (subtitle) {
      const centeredSubtitle = this.centerText(subtitle, opts.width);
      UIDisplay.text(UIStyles.heading.h2(centeredSubtitle));
    }
    if (opts.border) {
      UIDisplay.text(UIStyles.border.doubleLine(opts.width));
    }
    UIDisplay.newline();
  }
  /**
   * 创建页面尾部
   */
  static footer(content, options = {}) {
    const opts = { width: 80, border: true, ...options };
    UIDisplay.newline();
    if (opts.border) {
      UIDisplay.text(UIStyles.border.line(opts.width));
    }
    const centeredContent = this.centerText(content, opts.width);
    UIDisplay.text(UIStyles.status.muted(centeredContent));
    if (opts.border) {
      UIDisplay.text(UIStyles.border.line(opts.width));
    }
  }
  /**
   * 创建侧边栏布局
   */
  static sidebar(sidebarContent, mainContent, options = {}) {
    const opts = { sidebarWidth: 20, totalWidth: 80, ...options };
    const mainWidth = opts.totalWidth - opts.sidebarWidth - 3;
    const maxLines = Math.max(sidebarContent.length, mainContent.length);
    for (let i = 0; i < maxLines; i++) {
      const sidebar = (sidebarContent[i] || "").padEnd(opts.sidebarWidth);
      const main2 = mainContent[i] || "";
      UIDisplay.text(`${UIStyles.status.muted(sidebar)} \u2502 ${main2}`);
    }
  }
  /**
   * 创建分栏布局
   */
  static columns(columns, options = {}) {
    const opts = { totalWidth: 80, ...options };
    const colCount = columns.length;
    const columnWidths = opts.columnWidths || Array(colCount).fill(Math.floor((opts.totalWidth - (colCount - 1) * 3) / colCount));
    const maxLines = Math.max(...columns.map((col) => col.length));
    for (let i = 0; i < maxLines; i++) {
      const line = columns.map((col, colIndex) => {
        const content = col[i] || "";
        const width = columnWidths[colIndex];
        return content.padEnd(width).substring(0, width);
      }).join(" \u2502 ");
      UIDisplay.text(line);
    }
  }
  /**
   * 创建框框
   */
  static box(content, options = {}) {
    const opts = {
      width: 60,
      padding: 1,
      style: "single",
      align: "left",
      ...options
    };
    const lines = Array.isArray(content) ? content : content.split("\n");
    const boxChars = this.getBoxChars(opts.style);
    const contentWidth = opts.width - 2 - opts.padding * 2;
    UIDisplay.text(
      boxChars.topLeft + boxChars.horizontal.repeat(opts.width - 2) + boxChars.topRight
    );
    for (let i = 0; i < opts.padding; i++) {
      UIDisplay.text(boxChars.vertical + " ".repeat(opts.width - 2) + boxChars.vertical);
    }
    lines.forEach((line) => {
      const trimmedLine = line.substring(0, contentWidth);
      const alignedLine = this.alignText(trimmedLine, contentWidth, opts.align);
      UIDisplay.text(
        boxChars.vertical + " ".repeat(opts.padding) + alignedLine + " ".repeat(opts.padding) + boxChars.vertical
      );
    });
    for (let i = 0; i < opts.padding; i++) {
      UIDisplay.text(boxChars.vertical + " ".repeat(opts.width - 2) + boxChars.vertical);
    }
    UIDisplay.text(
      boxChars.bottomLeft + boxChars.horizontal.repeat(opts.width - 2) + boxChars.bottomRight
    );
  }
  /**
   * 创建卡片布局
   */
  static card(title, content, options = {}) {
    const lines = Array.isArray(content) ? content : content.split("\n");
    const cardContent = [
      options.icon ? `${options.icon} ${title}` : title,
      UIStyles.border.line(Math.min(title.length + (options.icon ? 3 : 0), 40)),
      "",
      ...lines
    ];
    this.box(cardContent, {
      ...options,
      align: "left"
    });
  }
  /**
   * 创建网格布局
   */
  static grid(items, options = {}) {
    const opts = { columns: 3, cellWidth: 20, spacing: 2, ...options };
    for (let i = 0; i < items.length; i += opts.columns) {
      const row = items.slice(i, i + opts.columns);
      const line = row.map((item) => {
        return item.padEnd(opts.cellWidth).substring(0, opts.cellWidth);
      }).join(" ".repeat(opts.spacing));
      UIDisplay.text(line);
    }
  }
  /**
   * 创建面板
   */
  static panel(sections, options = {}) {
    const opts = { width: 80, padding: 1, border: true, ...options };
    sections.forEach((section, index) => {
      if (index > 0) {
        UIDisplay.newline();
      }
      UIDisplay.section(section.title);
      const lines = Array.isArray(section.content) ? section.content : [section.content];
      lines.forEach((line) => {
        UIDisplay.text(line, { indent: 2 });
      });
    });
  }
  /**
   * 居中文本
   */
  static centerText(text, width) {
    const padding = Math.max(0, width - text.length);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return " ".repeat(leftPad) + text + " ".repeat(rightPad);
  }
  /**
   * 对齐文本
   */
  static alignText(text, width, align) {
    if (text.length >= width) {
      return text.substring(0, width);
    }
    const padding = width - text.length;
    switch (align) {
      case "center":
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        return " ".repeat(leftPad) + text + " ".repeat(rightPad);
      case "right":
        return " ".repeat(padding) + text;
      default:
        return text + " ".repeat(padding);
    }
  }
  /**
   * 获取边框字符
   */
  static getBoxChars(style) {
    switch (style) {
      case "double":
        return {
          topLeft: "\u2554",
          topRight: "\u2557",
          bottomLeft: "\u255A",
          bottomRight: "\u255D",
          horizontal: "\u2550",
          vertical: "\u2551"
        };
      case "rounded":
        return {
          topLeft: "\u256D",
          topRight: "\u256E",
          bottomLeft: "\u2570",
          bottomRight: "\u256F",
          horizontal: "\u2500",
          vertical: "\u2502"
        };
      case "bold":
        return {
          topLeft: "\u250F",
          topRight: "\u2513",
          bottomLeft: "\u2517",
          bottomRight: "\u251B",
          horizontal: "\u2501",
          vertical: "\u2503"
        };
      default:
        return {
          topLeft: "\u250C",
          topRight: "\u2510",
          bottomLeft: "\u2514",
          bottomRight: "\u2518",
          horizontal: "\u2500",
          vertical: "\u2502"
        };
    }
  }
  /**
   * 创建分隔器
   */
  static divider(text, options = {}) {
    const opts = { width: 80, style: "single", align: "center", ...options };
    if (!text) {
      const line2 = opts.style === "double" ? "\u2550" : "\u2500";
      UIDisplay.text(UIStyles.status.muted(line2.repeat(opts.width)));
      return;
    }
    const line = opts.style === "double" ? "\u2550" : "\u2500";
    const availableWidth = opts.width - text.length - 2;
    if (availableWidth <= 0) {
      UIDisplay.text(UIStyles.status.muted(text));
      return;
    }
    let leftPadding;
    let rightPadding;
    switch (opts.align) {
      case "left":
        leftPadding = 0;
        rightPadding = availableWidth;
        break;
      case "right":
        leftPadding = availableWidth;
        rightPadding = 0;
        break;
      default:
        leftPadding = Math.floor(availableWidth / 2);
        rightPadding = availableWidth - leftPadding;
        break;
    }
    const result = UIStyles.status.muted(line.repeat(leftPadding)) + " " + UIStyles.status.info(text) + " " + UIStyles.status.muted(line.repeat(rightPadding));
    UIDisplay.text(result);
  }
};

// packages/cli/src/ui/components/List.ts
init_styles();
var UIList = class {
  /**
   * 显示项目符号列表
   */
  static bullets(items, options = {}) {
    this.simple(items, { ...options, showBullets: true });
  }
  /**
   * 显示简单列表
   */
  static simple(items, options = {}) {
    const opts = {
      showNumbers: false,
      showBullets: true,
      indent: 0,
      separator: "",
      ...options
    };
    items.forEach((item, index) => {
      let prefix = "";
      if (opts.showNumbers) {
        prefix = UIStyles.status.muted(`${index + 1}. `);
      } else if (opts.showBullets) {
        prefix = UIStyles.status.muted("\u2022 ");
      }
      const text = prefix + item;
      UIDisplay.text(text, { indent: opts.indent });
      if (opts.separator && index < items.length - 1) {
        UIDisplay.text(opts.separator);
      }
    });
  }
  /**
   * 显示详细列表
   */
  static detailed(items, options = {}) {
    const opts = {
      showNumbers: false,
      showBullets: false,
      indent: 0,
      ...options
    };
    items.forEach((item, index) => {
      const indent = (item.indent || 0) + opts.indent;
      let prefix = "";
      if (opts.showNumbers) {
        prefix = UIStyles.status.muted(`${index + 1}. `);
      } else if (opts.showBullets) {
        prefix = UIStyles.status.muted("\u2022 ");
      }
      if (item.icon) {
        prefix += item.icon + " ";
      }
      if (item.status) {
        switch (item.status) {
          case "success":
            prefix += UIStyles.icon.success + " ";
            break;
          case "error":
            prefix += UIStyles.icon.error + " ";
            break;
          case "warning":
            prefix += UIStyles.icon.warning + " ";
            break;
          case "info":
            prefix += UIStyles.icon.info + " ";
            break;
        }
      }
      let text = prefix + UIStyles.component.label(item.label);
      if (item.value) {
        text += ": " + UIStyles.component.value(item.value);
      }
      UIDisplay.text(text, { indent });
      if (item.description) {
        const descText = UIStyles.status.muted(item.description);
        UIDisplay.text(descText, { indent: indent + 2 });
      }
    });
  }
  /**
   * 显示键值对列表
   */
  static keyValue(data, options = {}) {
    const items = Object.entries(data).map(([key, value]) => ({
      label: key,
      value
    }));
    this.detailed(items, options);
  }
  /**
   * 显示表格
   */
  static table(data, columns) {
    if (data.length === 0) {
      UIDisplay.muted("\u6CA1\u6709\u6570\u636E");
      return;
    }
    const colWidths = columns.map((col) => {
      const headerWidth = col.title.length;
      const dataWidth = Math.max(
        ...data.map((row) => {
          const value = row[col.key];
          const formatted = col.format ? col.format(value) : String(value || "");
          return formatted.length;
        })
      );
      return Math.max(headerWidth, dataWidth, col.width || 0);
    });
    const header = columns.map((col, i) => {
      const title = UIStyles.text.bold(col.title);
      const align = col.align || "left";
      return this.alignText(title, colWidths[i], align);
    }).join(" | ");
    UIDisplay.text(header);
    const separator = colWidths.map((width) => "\u2500".repeat(width)).join("\u2500\u253C\u2500");
    UIDisplay.muted("\u2500" + separator + "\u2500");
    data.forEach((row) => {
      const line = columns.map((col, i) => {
        const value = row[col.key];
        const formatted = col.format ? col.format(value) : String(value || "");
        const align = col.align || "left";
        return this.alignText(formatted, colWidths[i], align);
      }).join(" | ");
      UIDisplay.text(line);
    });
  }
  /**
   * 显示树形结构
   */
  static tree(items, options = {}) {
    const opts = {
      childrenKey: "children",
      labelKey: "label",
      showConnectors: true,
      ...options
    };
    const renderNode = (node, prefix = "", isLast = true) => {
      const label = typeof node === "string" ? node : node[opts.labelKey];
      const connector = opts.showConnectors ? isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 " : "";
      UIDisplay.text(prefix + connector + label);
      const children = typeof node === "object" ? node[opts.childrenKey] : null;
      if (children && Array.isArray(children)) {
        const newPrefix = prefix + (isLast ? "    " : "\u2502   ");
        children.forEach((child, index) => {
          const isLastChild = index === children.length - 1;
          renderNode(child, newPrefix, isLastChild);
        });
      }
    };
    items.forEach((item, index) => {
      const isLast = index === items.length - 1;
      renderNode(item, "", isLast);
    });
  }
  /**
   * 显示状态列表
   */
  static status(items) {
    const maxLength = Math.max(...items.map((item) => item.name.length));
    items.forEach((item) => {
      const name = item.name.padEnd(maxLength);
      let statusText = "";
      switch (item.status) {
        case "success":
          statusText = UIStyles.status.success("\u2713 \u6210\u529F");
          break;
        case "error":
          statusText = UIStyles.status.error("\u2717 \u5931\u8D25");
          break;
        case "warning":
          statusText = UIStyles.status.warning("\u26A0 \u8B66\u544A");
          break;
        case "pending":
          statusText = UIStyles.status.muted("\u25EF \u7B49\u5F85");
          break;
      }
      UIDisplay.text(`${UIStyles.component.label(name)} ${statusText}`);
    });
  }
  /**
   * 文本对齐助手
   */
  static alignText(text, width, align) {
    const plainText = text.replace(/\x1b\[[0-9;]*m/g, "");
    const padding = Math.max(0, width - plainText.length);
    switch (align) {
      case "center":
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        return " ".repeat(leftPad) + text + " ".repeat(rightPad);
      case "right":
        return " ".repeat(padding) + text;
      default:
        return text + " ".repeat(padding);
    }
  }
  /**
   * 分页显示
   */
  static paginated(items, pageSize = 10) {
    if (items.length <= pageSize) {
      this.simple(items);
      return;
    }
    const totalPages = Math.ceil(items.length / pageSize);
    const currentPage = 0;
    const showPage = () => {
      const start = currentPage * pageSize;
      const end = Math.min(start + pageSize, items.length);
      const pageItems = items.slice(start, end);
      UIDisplay.clear();
      UIDisplay.header(`\u7B2C ${currentPage + 1} \u9875\uFF0C\u5171 ${totalPages} \u9875`);
      UIDisplay.newline();
      this.simple(pageItems, { showNumbers: true });
      UIDisplay.newline();
      UIDisplay.muted(`\u663E\u793A ${start + 1}-${end} \u9879\uFF0C\u5171 ${items.length} \u9879`);
    };
    showPage();
  }
};

// packages/cli/src/ui/components/Progress.ts
init_styles();
var UIProgress = class {
  static spinners = {
    dots: ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"],
    line: ["|", "/", "-", "\\"],
    arrow: ["\u2190", "\u2196", "\u2191", "\u2197", "\u2192", "\u2198", "\u2193", "\u2199"],
    bounce: ["\u2801", "\u2802", "\u2804", "\u2802"],
    pulse: ["\u25CF", "\u25D0", "\u25D1", "\u25D2", "\u25D3", "\u25D4", "\u25D5", "\u25D6", "\u25D7", "\u25D8"]
  };
  /**
   * 创建旋转加载器
   */
  static spinner(text = "\u52A0\u8F7D\u4E2D...", options = {}) {
    return new Spinner(text, options);
  }
  /**
   * 创建进度条
   */
  static progressBar(total, options = {}) {
    return new ProgressBar(total, options);
  }
  /**
   * 显示步骤进度
   */
  static step(current, total, message) {
    const percentage = Math.round(current / total * 100);
    const progress = this.createProgressBar(percentage, 30);
    UIDisplay.text(
      `${UIStyles.status.info(`[${current}/${total}]`)} ${progress} ${percentage}% - ${message}`
    );
  }
  /**
   * 显示带时间的进度
   */
  static timedStep(current, total, message, startTime) {
    const elapsed = Date.now() - startTime;
    const rate = current / (elapsed / 1e3);
    const eta = rate > 0 ? Math.round((total - current) / rate) : 0;
    const percentage = Math.round(current / total * 100);
    const progress = this.createProgressBar(percentage, 20);
    const timeInfo = `${this.formatTime(elapsed)} | ETA: ${this.formatTime(eta * 1e3)}`;
    UIDisplay.text(
      `${UIStyles.status.info(`[${current}/${total}]`)} ${progress} ${percentage}% - ${message} (${UIStyles.status.muted(timeInfo)})`
    );
  }
  /**
   * 创建简单的进度条字符串
   */
  static createProgressBar(percentage, width = 20) {
    const filled = Math.round(percentage / 100 * width);
    const empty = width - filled;
    const filledBar = UIStyles.status.success("\u2588".repeat(filled));
    const emptyBar = UIStyles.status.muted("\u2591".repeat(empty));
    return `[${filledBar}${emptyBar}]`;
  }
  /**
   * 格式化时间
   */
  static formatTime(ms) {
    const seconds = Math.floor(ms / 1e3);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
  /**
   * 倒计时
   */
  static countdown(seconds, message = "\u5012\u8BA1\u65F6") {
    return new Promise((resolve5) => {
      let remaining = seconds;
      const timer = setInterval(() => {
        process.stdout.write(`\r${message}: ${UIStyles.status.warning(remaining.toString())}s `);
        remaining--;
        if (remaining < 0) {
          clearInterval(timer);
          process.stdout.write("\r");
          UIDisplay.success("\u5012\u8BA1\u65F6\u5B8C\u6210\uFF01");
          resolve5();
        }
      }, 1e3);
    });
  }
  /**
   * 模拟加载过程
   */
  static async simulate(duration, message = "\u5904\u7406\u4E2D") {
    const steps = 20;
    const stepDuration = duration / steps;
    for (let i = 0; i <= steps; i++) {
      const percentage = Math.round(i / steps * 100);
      const progress = this.createProgressBar(percentage);
      process.stdout.write(`\r${message}: ${progress} ${percentage}%`);
      if (i < steps) {
        await new Promise((resolve5) => setTimeout(resolve5, stepDuration));
      }
    }
    process.stdout.write("\n");
    UIDisplay.success("\u5B8C\u6210\uFF01");
  }
};
var Spinner = class {
  interval = null;
  frameIndex = 0;
  frames;
  text;
  options;
  constructor(text, options = {}) {
    this.text = text;
    this.options = {
      color: "blue",
      interval: 100,
      ...options
    };
    this.frames = UIProgress["spinners"].dots;
  }
  /**
   * 开始旋转
   */
  start() {
    if (this.interval) {
      this.stop();
    }
    this.interval = setInterval(() => {
      const frame = this.frames[this.frameIndex];
      const coloredFrame = this.colorize(frame);
      process.stdout.write(`\r${coloredFrame} ${this.text}`);
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    }, this.options.interval);
  }
  /**
   * 停止旋转
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write("\r");
    }
  }
  /**
   * 更新文本
   */
  updateText(text) {
    this.text = text;
  }
  /**
   * 成功完成
   */
  succeed(text) {
    this.stop();
    UIDisplay.success(text || this.text);
  }
  /**
   * 失败
   */
  fail(text) {
    this.stop();
    UIDisplay.error(text || this.text);
  }
  /**
   * 警告
   */
  warn(text) {
    this.stop();
    UIDisplay.warning(text || this.text);
  }
  /**
   * 信息
   */
  info(text) {
    this.stop();
    UIDisplay.info(text || this.text);
  }
  /**
   * 颜色化框架
   */
  colorize(frame) {
    switch (this.options.color) {
      case "green":
        return UIStyles.status.success(frame);
      case "yellow":
        return UIStyles.status.warning(frame);
      case "red":
        return UIStyles.status.error(frame);
      case "gray":
        return UIStyles.status.muted(frame);
      default:
        return UIStyles.status.info(frame);
    }
  }
};
var ProgressBar = class {
  current = 0;
  total;
  options;
  startTime;
  constructor(total, options = {}) {
    this.total = total;
    this.options = {
      width: 40,
      format: "{bar} {percentage}% | {current}/{total} | {eta}",
      complete: "\u2588",
      incomplete: "\u2591",
      renderThrottle: 16,
      ...options
    };
    this.startTime = Date.now();
  }
  /**
   * 更新进度
   */
  update(value) {
    this.current = Math.min(value, this.total);
    this.render();
  }
  /**
   * 增加进度
   */
  increment(delta = 1) {
    this.update(this.current + delta);
  }
  /**
   * 渲染进度条
   */
  render() {
    const percentage = Math.round(this.current / this.total * 100);
    const elapsed = Date.now() - this.startTime;
    const rate = this.current / (elapsed / 1e3);
    const eta = rate > 0 ? Math.round((this.total - this.current) / rate) : 0;
    const filledWidth = Math.round(this.current / this.total * this.options.width);
    const emptyWidth = this.options.width - filledWidth;
    const filledBar = UIStyles.status.success(this.options.complete.repeat(filledWidth));
    const emptyBar = UIStyles.status.muted(this.options.incomplete.repeat(emptyWidth));
    const bar = `[${filledBar}${emptyBar}]`;
    const output = this.options.format.replace("{bar}", bar).replace("{percentage}", percentage.toString()).replace("{current}", this.current.toString()).replace("{total}", this.total.toString()).replace("{eta}", this.formatTime(eta * 1e3));
    process.stdout.write(`\r${output}`);
    if (this.current >= this.total) {
      process.stdout.write("\n");
    }
  }
  /**
   * 完成进度条
   */
  complete() {
    this.update(this.total);
    UIDisplay.success("\u5B8C\u6210\uFF01");
  }
  /**
   * 格式化时间
   */
  formatTime(ms) {
    const seconds = Math.floor(ms / 1e3);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
};

// packages/cli/src/ui/index.ts
init_themes();

// packages/cli/src/ui/utils/formatter.ts
init_styles();

// packages/cli/src/commands/config.ts
function configCommand(program) {
  const configCmd = program.command("config").description("\u2699\uFE0F \u914D\u7F6E\u7BA1\u7406");
  const configManager = ConfigManager2.getInstance();
  configCmd.command("show").alias("s").description("\u{1F4CB} \u663E\u793A\u5F53\u524D\u914D\u7F6E").action(async () => {
    try {
      await configManager.initialize();
      const config = configManager.getConfig();
      UIDisplay.text(JSON.stringify(config, null, 2));
    } catch (error) {
      UIDisplay.error(`\u83B7\u53D6\u914D\u7F6E\u5931\u8D25: ${error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"}`);
    }
  });
  configCmd.command("reset").description("\u{1F504} \u91CD\u7F6E\u914D\u7F6E\u4E3A\u9ED8\u8BA4\u503C").action(async () => {
    const confirm = await UIInput.confirm("\u786E\u5B9A\u8981\u91CD\u7F6E\u6240\u6709\u914D\u7F6E\u5417\uFF1F\u8FD9\u5C06\u5220\u9664\u60A8\u7684\u7528\u6237\u914D\u7F6E\u3002", { default: false });
    if (confirm) {
      try {
        await configManager.resetConfig();
        UIDisplay.success("\u914D\u7F6E\u5DF2\u6210\u529F\u91CD\u7F6E\u4E3A\u9ED8\u8BA4\u503C\u3002");
      } catch (error) {
        UIDisplay.error(`\u91CD\u7F6E\u914D\u7F6E\u5931\u8D25: ${error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"}`);
      }
    } else {
      UIDisplay.muted("\u53D6\u6D88\u91CD\u7F6E");
    }
  });
}

// packages/cli/src/commands/llm.ts
import chalk5 from "chalk";
function llmCommand(program) {
  program.command("llm").description("\u{1F916} \u7EAF LLM \u6A21\u5F0F\u804A\u5929").argument("[message...]", "\u8981\u53D1\u9001\u7684\u6D88\u606F").option("-k, --api-key <key>", "API \u5BC6\u94A5").option("-u, --base-url <url>", "API \u57FA\u7840 URL").option("-m, --model <model>", "\u6A21\u578B\u540D\u79F0").option("--stream", "\u542F\u7528\u6D41\u5F0F\u8F93\u51FA", false).action(async (messageArgs, options) => {
    try {
      const config = {};
      if (options.apiKey) config.apiKey = options.apiKey;
      if (options.baseUrl) config.baseUrl = options.baseUrl;
      if (options.model) config.modelName = options.model;
      const agent = new Agent(config);
      const message = messageArgs.join(" ");
      if (!message) {
        console.log(chalk5.red("\u274C \u8BF7\u8F93\u5165\u8981\u53D1\u9001\u7684\u6D88\u606F"));
        return;
      }
      if (options.stream) {
        console.log(chalk5.green("\u{1F916} AI: "), { newline: false });
        console.log("\u6D41\u5F0F\u8F93\u51FA\u529F\u80FD\u5F00\u53D1\u4E2D...");
      } else {
        const response = await agent.chat(message);
        console.log(chalk5.green(`\u{1F916} AI: ${response}`));
      }
    } catch (error) {
      console.error(chalk5.red("\u274C LLM \u8C03\u7528\u5931\u8D25:"), error);
    }
  });
}

// packages/cli/src/commands/mcp.ts
import chalk6 from "chalk";
import inquirer3 from "inquirer";
import { Client, Server as Server2 } from "@modelcontextprotocol/sdk";
function mcpCommand(program) {
  const mcpCmd = program.command("mcp").description("\u{1F517} MCP (Model Context Protocol) \u7BA1\u7406\u547D\u4EE4");
  const serverCmd = mcpCmd.command("server").description("MCP \u670D\u52A1\u5668\u7BA1\u7406");
  serverCmd.command("start").description("\u542F\u52A8 MCP \u670D\u52A1\u5668").option("-p, --port <port>", "\u76D1\u542C\u7AEF\u53E3", "3001").option("-h, --host <host>", "\u76D1\u542C\u5730\u5740", "localhost").option("-t, --transport <type>", "\u4F20\u8F93\u7C7B\u578B (ws|stdio)", "ws").action(async (options) => {
    let spinner = UIProgress.spinner("\u6B63\u5728\u521D\u59CB\u5316\u670D\u52A1\u5668\u914D\u7F6E...");
    spinner.start();
    try {
      const serverConfig = mcpConfig.getServerConfig();
      const config = {
        port: parseInt(options.port) || serverConfig.port,
        host: options.host || serverConfig.host,
        transport: options.transport || serverConfig.transport,
        auth: serverConfig.auth
      };
      spinner.succeed("\u914D\u7F6E\u521D\u59CB\u5316\u5B8C\u6210");
      spinner = UIProgress.spinner("\u6B63\u5728\u542F\u52A8\u5DE5\u5177\u7BA1\u7406\u5668...");
      spinner.start();
      const toolManager = await createToolManager();
      spinner.succeed("\u5DE5\u5177\u7BA1\u7406\u5668\u542F\u52A8\u5B8C\u6210");
      UILayout.card(
        "MCP \u670D\u52A1\u5668\u914D\u7F6E",
        [
          `\u4F20\u8F93\u65B9\u5F0F: ${config.transport}`,
          config.transport === "ws" ? `\u76D1\u542C\u5730\u5740: ws://${config.host}:${config.port}` : null
        ].filter(Boolean),
        { icon: "\u{1F680}" }
      );
      spinner = UIProgress.spinner("\u6B63\u5728\u542F\u52A8 MCP \u670D\u52A1\u5668...");
      spinner.start();
      const server = new Server2(config, toolManager);
      await server.start();
      server.on("started", (info) => {
        spinner.succeed("MCP \u670D\u52A1\u5668\u542F\u52A8\u6210\u529F");
        if (info.host && info.port) {
          UIDisplay.success(`\u670D\u52A1\u5668\u5730\u5740: ws://${info.host}:${info.port}`);
        }
        UIDisplay.info("\u6309 Ctrl+C \u505C\u6B62\u670D\u52A1\u5668");
      });
      server.on("error", (error) => {
        UIDisplay.error(`\u670D\u52A1\u5668\u9519\u8BEF: ${error.message}`);
      });
      process.on("SIGINT", async () => {
        const exitSpinner = UIProgress.spinner("\u6B63\u5728\u505C\u6B62\u670D\u52A1\u5668...");
        exitSpinner.start();
        await server.stop();
        exitSpinner.succeed("\u670D\u52A1\u5668\u5DF2\u505C\u6B62");
        process.exit(0);
      });
    } catch (error) {
      if (spinner) spinner.fail("\u670D\u52A1\u5668\u542F\u52A8\u5931\u8D25");
      UIDisplay.error(`\u9519\u8BEF: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });
  const clientCmd = mcpCmd.command("client").description("MCP \u5BA2\u6237\u7AEF\u7BA1\u7406");
  clientCmd.command("connect <server>").description("\u8FDE\u63A5\u5230 MCP \u670D\u52A1\u5668").option("-i, --interactive", "\u4EA4\u4E92\u5F0F\u6A21\u5F0F").action(async (serverName, options) => {
    let spinner = UIProgress.spinner("\u6B63\u5728\u9A8C\u8BC1\u670D\u52A1\u5668\u914D\u7F6E...");
    spinner.start();
    try {
      const serverConfig = mcpConfig.getServer(serverName);
      if (!serverConfig) {
        spinner.fail("\u670D\u52A1\u5668\u914D\u7F6E\u4E0D\u5B58\u5728");
        UIDisplay.error(`\u672A\u627E\u5230\u670D\u52A1\u5668\u914D\u7F6E: ${serverName}`);
        UIDisplay.info('\u4F7F\u7528 "blade mcp config add" \u6DFB\u52A0\u670D\u52A1\u5668\u914D\u7F6E');
        return;
      }
      spinner.succeed("\u670D\u52A1\u5668\u914D\u7F6E\u9A8C\u8BC1\u5B8C\u6210");
      UILayout.card(
        "\u8FDE\u63A5\u4FE1\u606F",
        [
          `\u670D\u52A1\u5668: ${serverName}`,
          `\u5730\u5740: ${serverConfig.endpoint || serverConfig.command}`,
          `\u4F20\u8F93\u65B9\u5F0F: ${serverConfig.transport}`
        ],
        { icon: "\u{1F517}" }
      );
      spinner = UIProgress.spinner("\u6B63\u5728\u8FDE\u63A5\u5230 MCP \u670D\u52A1\u5668...");
      spinner.start();
      const client = new Client();
      const session = await client.connect(serverConfig);
      spinner.succeed("\u8FDE\u63A5\u6210\u529F");
      UILayout.card(
        "\u4F1A\u8BDD\u4FE1\u606F",
        [
          `\u4F1A\u8BDD ID: ${session.id}`,
          session.serverInfo ? `\u670D\u52A1\u5668: ${session.serverInfo.name} v${session.serverInfo.version}` : null
        ].filter(Boolean),
        { icon: "\u2705" }
      );
      if (options.interactive) {
        await runInteractiveClient(client, session.id);
      } else {
        await showServerInfo(client, session.id);
      }
      const disconnectSpinner = UIProgress.spinner("\u6B63\u5728\u65AD\u5F00\u8FDE\u63A5...");
      disconnectSpinner.start();
      await client.disconnect(session.id);
      disconnectSpinner.succeed("\u8FDE\u63A5\u5DF2\u65AD\u5F00");
    } catch (error) {
      if (spinner) spinner.fail("\u8FDE\u63A5\u5931\u8D25");
      UIDisplay.error(`\u9519\u8BEF: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });
  clientCmd.command("list").description("\u5217\u51FA\u5DF2\u914D\u7F6E\u7684\u670D\u52A1\u5668").action(() => {
    const servers = mcpConfig.getServers();
    const serverNames = Object.keys(servers);
    if (serverNames.length === 0) {
      UIDisplay.warning("\u6682\u65E0\u914D\u7F6E\u7684 MCP \u670D\u52A1\u5668");
      UIDisplay.info('\u4F7F\u7528 "blade mcp config add" \u6DFB\u52A0\u670D\u52A1\u5668\u914D\u7F6E');
      return;
    }
    UIDisplay.section("\u5DF2\u914D\u7F6E\u7684 MCP \u670D\u52A1\u5668");
    const serverList = serverNames.map((name) => {
      const config = servers[name];
      let info = `${name} (${config.transport})`;
      if (config.endpoint) {
        info += ` - ${config.endpoint}`;
      } else if (config.command) {
        info += ` - ${config.command}`;
      }
      return info;
    });
    UIList.simple(serverList);
    UIDisplay.info(`\u5171 ${serverNames.length} \u4E2A\u670D\u52A1\u5668`);
  });
  const configCmd = mcpCmd.command("config").description("MCP \u914D\u7F6E\u7BA1\u7406");
  configCmd.command("add").description("\u6DFB\u52A0 MCP \u670D\u52A1\u5668\u914D\u7F6E").action(async () => {
    try {
      UIDisplay.header("\u6DFB\u52A0 MCP \u670D\u52A1\u5668\u914D\u7F6E");
      const name = await UIInput.text("\u670D\u52A1\u5668\u540D\u79F0:", {
        validate: (input) => input.trim() ? true : "\u8BF7\u8F93\u5165\u670D\u52A1\u5668\u540D\u79F0"
      });
      const transport = await UIInput.select("\u4F20\u8F93\u65B9\u5F0F:", [
        { name: "WebSocket (ws)", value: "ws" },
        { name: "Standard I/O (stdio)", value: "stdio" }
      ]);
      let config = {
        name,
        transport
      };
      if (transport === "ws") {
        const endpoint = await UIInput.text("WebSocket \u5730\u5740:", {
          default: "ws://localhost:3001",
          validate: (input) => input.trim() ? true : "\u8BF7\u8F93\u5165 WebSocket \u5730\u5740"
        });
        const timeout = await UIInput.text("\u8FDE\u63A5\u8D85\u65F6 (\u6BEB\u79D2):", {
          default: "10000",
          validate: (input) => !isNaN(Number(input)) ? true : "\u8BF7\u8F93\u5165\u6709\u6548\u6570\u5B57"
        });
        config = {
          ...config,
          endpoint,
          timeout: parseInt(timeout)
        };
      } else {
        const command = await UIInput.text("\u6267\u884C\u547D\u4EE4:", {
          validate: (input) => input.trim() ? true : "\u8BF7\u8F93\u5165\u6267\u884C\u547D\u4EE4"
        });
        const args = await UIInput.text("\u547D\u4EE4\u53C2\u6570 (\u53EF\u9009):", { default: "" });
        config = {
          ...config,
          command,
          args: args ? args.split(" ") : void 0
        };
      }
      const spinner = UIProgress.spinner("\u6B63\u5728\u4FDD\u5B58\u914D\u7F6E...");
      spinner.start();
      mcpConfig.addServer(name, config);
      spinner.succeed("\u670D\u52A1\u5668\u914D\u7F6E\u6DFB\u52A0\u6210\u529F");
      UILayout.card(
        "\u914D\u7F6E\u8BE6\u60C5",
        [
          `\u540D\u79F0: ${config.name}`,
          `\u4F20\u8F93\u65B9\u5F0F: ${config.transport}`,
          config.endpoint ? `\u5730\u5740: ${config.endpoint}` : null,
          config.command ? `\u547D\u4EE4: ${config.command}` : null
        ].filter(Boolean),
        { icon: "\u2705" }
      );
    } catch (error) {
      UIDisplay.error(`\u914D\u7F6E\u6DFB\u52A0\u5931\u8D25: ${error.message}`);
    }
  });
  configCmd.command("remove <name>").description("\u5220\u9664\u670D\u52A1\u5668\u914D\u7F6E").action(async (name) => {
    try {
      const servers = mcpConfig.getServers();
      if (!servers[name]) {
        UIDisplay.error(`\u670D\u52A1\u5668\u914D\u7F6E "${name}" \u4E0D\u5B58\u5728`);
        return;
      }
      UILayout.card("\u5C06\u8981\u5220\u9664\u7684\u914D\u7F6E", [`\u540D\u79F0: ${name}`, `\u4F20\u8F93\u65B9\u5F0F: ${servers[name].transport}`], {
        icon: "\u26A0\uFE0F"
      });
      const confirmed = await UIInput.confirm("\u786E\u8BA4\u5220\u9664\u6B64\u914D\u7F6E\uFF1F", { default: false });
      if (!confirmed) {
        UIDisplay.info("\u64CD\u4F5C\u5DF2\u53D6\u6D88");
        return;
      }
      const spinner = UIProgress.spinner("\u6B63\u5728\u5220\u9664\u914D\u7F6E...");
      spinner.start();
      mcpConfig.removeServer(name);
      spinner.succeed(`\u670D\u52A1\u5668\u914D\u7F6E "${name}" \u5DF2\u5220\u9664`);
    } catch (error) {
      UIDisplay.error(`\u5220\u9664\u914D\u7F6E\u5931\u8D25: ${error.message}`);
    }
  });
  configCmd.command("show [name]").description("\u663E\u793A\u670D\u52A1\u5668\u914D\u7F6E").action((name) => {
    var _a;
    try {
      if (name) {
        const config = mcpConfig.getServer(name);
        if (!config) {
          UIDisplay.error(`\u670D\u52A1\u5668\u914D\u7F6E "${name}" \u4E0D\u5B58\u5728`);
          return;
        }
        UILayout.card(
          `\u670D\u52A1\u5668\u914D\u7F6E: ${name}`,
          [
            `\u4F20\u8F93\u65B9\u5F0F: ${config.transport}`,
            config.endpoint ? `\u5730\u5740: ${config.endpoint}` : null,
            config.command ? `\u547D\u4EE4: ${config.command}` : null,
            ((_a = config.args) == null ? void 0 : _a.length) ? `\u53C2\u6570: ${config.args.join(" ")}` : null,
            config.timeout ? `\u8D85\u65F6: ${config.timeout}ms` : null
          ].filter(Boolean),
          { icon: "\u{1F4CB}" }
        );
      } else {
        const servers = mcpConfig.getServers();
        const serverNames = Object.keys(servers);
        if (serverNames.length === 0) {
          UIDisplay.warning("\u6682\u65E0\u914D\u7F6E\u7684\u670D\u52A1\u5668");
          return;
        }
        UIDisplay.section("\u6240\u6709\u670D\u52A1\u5668\u914D\u7F6E");
        serverNames.forEach((serverName) => {
          const config = servers[serverName];
          UILayout.card(
            serverName,
            [
              `\u4F20\u8F93\u65B9\u5F0F: ${config.transport}`,
              config.endpoint ? `\u5730\u5740: ${config.endpoint}` : null,
              config.command ? `\u547D\u4EE4: ${config.command}` : null
            ].filter(Boolean)
          );
          UIDisplay.newline();
        });
      }
    } catch (error) {
      UIDisplay.error(`\u83B7\u53D6\u914D\u7F6E\u5931\u8D25: ${error.message}`);
    }
  });
}
async function runInteractiveClient(client, sessionId) {
  console.log(chalk6.blue('\n\u{1F3AE} \u8FDB\u5165\u4EA4\u4E92\u5F0F\u6A21\u5F0F (\u8F93\u5165 "exit" \u9000\u51FA)'));
  console.log("");
  while (true) {
    try {
      const { action } = await inquirer3.prompt([
        {
          type: "list",
          name: "action",
          message: "\u9009\u62E9\u64CD\u4F5C:",
          choices: [
            { name: "\u{1F4CB} \u5217\u51FA\u8D44\u6E90", value: "list-resources" },
            { name: "\u{1F4D6} \u8BFB\u53D6\u8D44\u6E90", value: "read-resource" },
            { name: "\u{1F527} \u5217\u51FA\u5DE5\u5177", value: "list-tools" },
            { name: "\u26A1 \u8C03\u7528\u5DE5\u5177", value: "call-tool" },
            { name: "\u{1F6AA} \u9000\u51FA", value: "exit" }
          ]
        }
      ]);
      if (action === "exit") {
        break;
      }
      switch (action) {
        case "list-resources":
          await listResources(client, sessionId);
          break;
        case "read-resource":
          await readResource(client, sessionId);
          break;
        case "list-tools":
          await listTools(client, sessionId);
          break;
        case "call-tool":
          await callTool(client, sessionId);
          break;
      }
      console.log("");
    } catch (error) {
      console.error(chalk6.red("\u274C \u64CD\u4F5C\u5931\u8D25:"), error instanceof Error ? error.message : error);
    }
  }
}
async function showServerInfo(client, sessionId) {
  try {
    console.log(chalk6.blue("\n\u{1F4CB} \u670D\u52A1\u5668\u4FE1\u606F:"));
    const resources = await client.listResources(sessionId);
    console.log(chalk6.green(`\u{1F4C1} \u53EF\u7528\u8D44\u6E90 (${resources.length}):`));
    resources.forEach((resource) => {
      console.log(chalk6.gray(`   \u2022 ${resource.name}: ${resource.description || resource.uri}`));
    });
    const tools = await client.listTools(sessionId);
    console.log(chalk6.green(`\u{1F527} \u53EF\u7528\u5DE5\u5177 (${tools.length}):`));
    tools.forEach((tool) => {
      console.log(chalk6.gray(`   \u2022 ${tool.name}: ${tool.description}`));
    });
  } catch (error) {
    console.error(
      chalk6.red("\u274C \u83B7\u53D6\u670D\u52A1\u5668\u4FE1\u606F\u5931\u8D25:"),
      error instanceof Error ? error.message : error
    );
  }
}
async function listResources(client, sessionId) {
  try {
    const resources = await client.listResources(sessionId);
    if (resources.length === 0) {
      console.log(chalk6.yellow("\u{1F4ED} \u6CA1\u6709\u53EF\u7528\u7684\u8D44\u6E90"));
      return;
    }
    console.log(chalk6.blue(`\u{1F4C1} \u53EF\u7528\u8D44\u6E90 (${resources.length}):`));
    resources.forEach((resource, index) => {
      console.log(chalk6.green(`${index + 1}. ${resource.name}`));
      console.log(chalk6.gray(`   URI: ${resource.uri}`));
      if (resource.description) {
        console.log(chalk6.gray(`   \u63CF\u8FF0: ${resource.description}`));
      }
      if (resource.mimeType) {
        console.log(chalk6.gray(`   \u7C7B\u578B: ${resource.mimeType}`));
      }
      console.log("");
    });
  } catch (error) {
    console.error(
      chalk6.red("\u274C \u83B7\u53D6\u8D44\u6E90\u5217\u8868\u5931\u8D25:"),
      error instanceof Error ? error.message : error
    );
  }
}
async function readResource(client, sessionId) {
  try {
    const resources = await client.listResources(sessionId);
    if (resources.length === 0) {
      console.log(chalk6.yellow("\u{1F4ED} \u6CA1\u6709\u53EF\u7528\u7684\u8D44\u6E90"));
      return;
    }
    const { selectedResource } = await inquirer3.prompt([
      {
        type: "list",
        name: "selectedResource",
        message: "\u9009\u62E9\u8981\u8BFB\u53D6\u7684\u8D44\u6E90:",
        choices: resources.map((resource) => ({
          name: `${resource.name} (${resource.uri})`,
          value: resource.uri
        }))
      }
    ]);
    const content = await client.readResource(sessionId, selectedResource);
    console.log(chalk6.blue(`\u{1F4D6} \u8D44\u6E90\u5185\u5BB9 (${content.mimeType}):`));
    console.log("");
    console.log(content.text || content.blob || "[\u4E8C\u8FDB\u5236\u5185\u5BB9]");
  } catch (error) {
    console.error(chalk6.red("\u274C \u8BFB\u53D6\u8D44\u6E90\u5931\u8D25:"), error instanceof Error ? error.message : error);
  }
}
async function listTools(client, sessionId) {
  try {
    const tools = await client.listTools(sessionId);
    if (tools.length === 0) {
      console.log(chalk6.yellow("\u{1F527} \u6CA1\u6709\u53EF\u7528\u7684\u5DE5\u5177"));
      return;
    }
    console.log(chalk6.blue(`\u{1F527} \u53EF\u7528\u5DE5\u5177 (${tools.length}):`));
    tools.forEach((tool, index) => {
      console.log(chalk6.green(`${index + 1}. ${tool.name}`));
      console.log(chalk6.gray(`   \u63CF\u8FF0: ${tool.description}`));
      const properties = tool.inputSchema.properties;
      if (properties && Object.keys(properties).length > 0) {
        console.log(chalk6.gray("   \u53C2\u6570:"));
        Object.entries(properties).forEach(([key, value]) => {
          var _a;
          const required = ((_a = tool.inputSchema.required) == null ? void 0 : _a.includes(key)) ? " (\u5FC5\u9700)" : "";
          console.log(chalk6.gray(`     \u2022 ${key}${required}: ${value.description || value.type}`));
        });
      }
      console.log("");
    });
  } catch (error) {
    console.error(
      chalk6.red("\u274C \u83B7\u53D6\u5DE5\u5177\u5217\u8868\u5931\u8D25:"),
      error instanceof Error ? error.message : error
    );
  }
}
async function callTool(client, sessionId) {
  var _a;
  try {
    const tools = await client.listTools(sessionId);
    if (tools.length === 0) {
      console.log(chalk6.yellow("\u{1F527} \u6CA1\u6709\u53EF\u7528\u7684\u5DE5\u5177"));
      return;
    }
    const { selectedTool } = await inquirer3.prompt([
      {
        type: "list",
        name: "selectedTool",
        message: "\u9009\u62E9\u8981\u8C03\u7528\u7684\u5DE5\u5177:",
        choices: tools.map((tool2) => ({
          name: `${tool2.name} - ${tool2.description}`,
          value: tool2.name
        }))
      }
    ]);
    const tool = tools.find((t) => t.name === selectedTool);
    const toolArgs = {};
    const properties = tool.inputSchema.properties;
    if (properties && Object.keys(properties).length > 0) {
      console.log(chalk6.blue("\u{1F4DD} \u8BF7\u8F93\u5165\u5DE5\u5177\u53C2\u6570:"));
      for (const [key] of Object.entries(properties)) {
        const isRequired = (_a = tool.inputSchema.required) == null ? void 0 : _a.includes(key);
        const { value } = await inquirer3.prompt([
          {
            type: "input",
            name: "value",
            message: `${key}${isRequired ? " (\u5FC5\u9700)" : ""}:`,
            validate: (input) => {
              if (isRequired && !input.trim()) {
                return `${key} \u662F\u5FC5\u9700\u53C2\u6570`;
              }
              return true;
            }
          }
        ]);
        if (value.trim()) {
          toolArgs[key] = value;
        }
      }
    }
    console.log(chalk6.blue("\u26A1 \u8C03\u7528\u5DE5\u5177..."));
    const result = await client.callTool(sessionId, {
      name: selectedTool,
      arguments: toolArgs
    });
    console.log(chalk6.green("\u2705 \u5DE5\u5177\u8C03\u7528\u6210\u529F:"));
    console.log("");
    result.content.forEach((content) => {
      if (content.type === "text") {
        console.log(content.text);
      } else {
        console.log(chalk6.gray(`[${content.type}\u5185\u5BB9]`));
      }
    });
    if (result.isError) {
      console.log(chalk6.red("\u26A0\uFE0F  \u5DE5\u5177\u6267\u884C\u51FA\u73B0\u9519\u8BEF"));
    }
  } catch (error) {
    console.error(chalk6.red("\u274C \u8C03\u7528\u5DE5\u5177\u5931\u8D25:"), error instanceof Error ? error.message : error);
  }
}

// packages/cli/src/commands/tools.ts
function toolsCommand(program) {
  const toolsCmd = program.command("tools").description("\u{1F527} \u5DE5\u5177\u7BA1\u7406\u548C\u64CD\u4F5C");
  toolsCmd.command("list").description("\u5217\u51FA\u6240\u6709\u53EF\u7528\u5DE5\u5177").option("-c, --category <category>", "\u6309\u5206\u7C7B\u8FC7\u6EE4").option("-s, --search <query>", "\u641C\u7D22\u5DE5\u5177").option("--format <format>", "\u8F93\u51FA\u683C\u5F0F", "table").action(async (options) => {
    const spinner = UIProgress.spinner("\u6B63\u5728\u52A0\u8F7D\u5DE5\u5177\u5217\u8868...");
    spinner.start();
    try {
      const toolManager = await createToolManager();
      let tools = toolManager.getTools();
      if (options.category) {
        tools = tools.filter(
          (tool) => {
            var _a;
            return ((_a = tool.category) == null ? void 0 : _a.toLowerCase()) === options.category.toLowerCase();
          }
        );
      }
      if (options.search) {
        const query = options.search.toLowerCase();
        tools = tools.filter(
          (tool) => tool.name.toLowerCase().includes(query) || tool.description.toLowerCase().includes(query) || tool.tags && tool.tags.some((tag) => tag.toLowerCase().includes(query))
        );
      }
      spinner.succeed("\u5DE5\u5177\u5217\u8868\u52A0\u8F7D\u5B8C\u6210");
      if (tools.length === 0) {
        UIDisplay.warning("\u672A\u627E\u5230\u5339\u914D\u7684\u5DE5\u5177");
        return;
      }
      if (options.format === "json") {
        console.log(JSON.stringify(tools, null, 2));
      } else {
        displayToolsTable(tools);
      }
    } catch (error) {
      spinner.fail("\u5DE5\u5177\u5217\u8868\u83B7\u53D6\u5931\u8D25");
      UIDisplay.error(`\u9519\u8BEF: ${error.message}`);
    }
  });
  toolsCmd.command("info <toolName>").description("\u67E5\u770B\u5DE5\u5177\u8BE6\u7EC6\u4FE1\u606F").action(async (toolName) => {
    const spinner = UIProgress.spinner(`\u6B63\u5728\u83B7\u53D6\u5DE5\u5177 "${toolName}" \u7684\u4FE1\u606F...`);
    spinner.start();
    try {
      const toolManager = await createToolManager();
      const tool = toolManager.getTool(toolName);
      if (!tool) {
        spinner.fail("\u5DE5\u5177\u4E0D\u5B58\u5728");
        UIDisplay.error(`\u5DE5\u5177 "${toolName}" \u4E0D\u5B58\u5728`);
        return;
      }
      spinner.succeed("\u5DE5\u5177\u4FE1\u606F\u83B7\u53D6\u5B8C\u6210");
      displayToolInfo(tool);
    } catch (error) {
      spinner.fail("\u5DE5\u5177\u4FE1\u606F\u83B7\u53D6\u5931\u8D25");
      UIDisplay.error(`\u9519\u8BEF: ${error.message}`);
    }
  });
  toolsCmd.command("call <toolName>").description("\u8C03\u7528\u6307\u5B9A\u5DE5\u5177").option("-p, --params <params>", "\u5DE5\u5177\u53C2\u6570\uFF08JSON\u683C\u5F0F\uFF09", "{}").option("-f, --file <file>", "\u4ECE\u6587\u4EF6\u8BFB\u53D6\u53C2\u6570").action(async (toolName, options) => {
    let spinner = UIProgress.spinner("\u6B63\u5728\u9A8C\u8BC1\u5DE5\u5177...");
    spinner.start();
    try {
      const toolManager = await createToolManager();
      if (!toolManager.hasTool(toolName)) {
        spinner.fail("\u5DE5\u5177\u4E0D\u5B58\u5728");
        UIDisplay.error(`\u5DE5\u5177 "${toolName}" \u4E0D\u5B58\u5728`);
        return;
      }
      spinner.succeed("\u5DE5\u5177\u9A8C\u8BC1\u5B8C\u6210");
      let params = {};
      if (options.file) {
        spinner = UIProgress.spinner("\u6B63\u5728\u8BFB\u53D6\u53C2\u6570\u6587\u4EF6...");
        spinner.start();
        const fs9 = await import("fs/promises");
        const fileContent = await fs9.readFile(options.file, "utf8");
        params = JSON.parse(fileContent);
        spinner.succeed("\u53C2\u6570\u6587\u4EF6\u8BFB\u53D6\u5B8C\u6210");
      } else {
        params = JSON.parse(options.params);
      }
      UILayout.card(
        "\u5DE5\u5177\u8C03\u7528",
        [`\u5DE5\u5177\u540D\u79F0: ${toolName}`, `\u53C2\u6570: ${JSON.stringify(params, null, 2)}`],
        { icon: "\u{1F527}" }
      );
      const confirmed = await UIInput.confirm("\u786E\u8BA4\u8C03\u7528\u8BE5\u5DE5\u5177\uFF1F", { default: true });
      if (!confirmed) {
        UIDisplay.info("\u64CD\u4F5C\u5DF2\u53D6\u6D88");
        return;
      }
      spinner = UIProgress.spinner("\u6B63\u5728\u8C03\u7528\u5DE5\u5177...");
      spinner.start();
      const response = await toolManager.callTool({
        toolName,
        parameters: params
      });
      spinner.succeed("\u5DE5\u5177\u8C03\u7528\u5B8C\u6210");
      displayToolResult(response);
    } catch (error) {
      if (spinner) spinner.fail("\u5DE5\u5177\u8C03\u7528\u5931\u8D25");
      UIDisplay.error(`\u9519\u8BEF: ${error.message}`);
    }
  });
  toolsCmd.command("docs").description("\u751F\u6210\u5DE5\u5177\u6587\u6863").option("-o, --output <file>", "\u8F93\u51FA\u6587\u4EF6\u8DEF\u5F84").option("-f, --format <format>", "\u6587\u6863\u683C\u5F0F", "markdown").action(async (options) => {
    const spinner = UIProgress.spinner("\u6B63\u5728\u751F\u6210\u5DE5\u5177\u6587\u6863...");
    spinner.start();
    try {
      const toolManager = await createToolManager();
      const tools = toolManager.getTools();
      const categories = getBuiltinToolsByCategory();
      const docs = generateToolDocs(tools, categories);
      if (options.output) {
        const fs9 = await import("fs/promises");
        await fs9.writeFile(options.output, docs, "utf8");
        spinner.succeed(`\u5DE5\u5177\u6587\u6863\u5DF2\u4FDD\u5B58\u5230: ${options.output}`);
      } else {
        spinner.succeed("\u5DE5\u5177\u6587\u6863\u751F\u6210\u5B8C\u6210");
        console.log(docs);
      }
    } catch (error) {
      spinner.fail("\u6587\u6863\u751F\u6210\u5931\u8D25");
      UIDisplay.error(`\u9519\u8BEF: ${error.message}`);
    }
  });
  toolsCmd.command("stats").description("\u663E\u793A\u5DE5\u5177\u7EDF\u8BA1\u4FE1\u606F").action(async () => {
    const spinner = UIProgress.spinner("\u6B63\u5728\u6536\u96C6\u7EDF\u8BA1\u4FE1\u606F...");
    spinner.start();
    try {
      const toolManager = await createToolManager();
      const stats = toolManager.getStats();
      const categories = getBuiltinToolsByCategory();
      spinner.succeed("\u7EDF\u8BA1\u4FE1\u606F\u6536\u96C6\u5B8C\u6210");
      UILayout.card(
        "\u5DE5\u5177\u7EDF\u8BA1\u4FE1\u606F",
        [
          `\u603B\u5DE5\u5177\u6570: ${stats.totalTools}`,
          `\u542F\u7528\u5DE5\u5177: ${stats.enabledTools}`,
          `\u7981\u7528\u5DE5\u5177: ${stats.totalTools - stats.enabledTools}`,
          `\u6B63\u5728\u8FD0\u884C: ${stats.runningExecutions}`,
          "",
          "\u6267\u884C\u7EDF\u8BA1:",
          `  \u603B\u6267\u884C\u6B21\u6570: ${stats.totalExecutions}`,
          `  \u6210\u529F\u6267\u884C: ${stats.successfulExecutions}`,
          `  \u5931\u8D25\u6267\u884C: ${stats.failedExecutions}`
        ],
        { icon: "\u{1F4CA}" }
      );
      UIDisplay.section("\u5206\u7C7B\u7EDF\u8BA1");
      const categoryStats = Object.entries(categories).map(
        ([category, tools]) => `${category}: ${tools.length} \u4E2A\u5DE5\u5177`
      );
      UIList.simple(categoryStats);
    } catch (error) {
      spinner.fail("\u7EDF\u8BA1\u4FE1\u606F\u83B7\u53D6\u5931\u8D25");
      UIDisplay.error(`\u9519\u8BEF: ${error.message}`);
    }
  });
  toolsCmd.command("test <toolName>").description("\u6D4B\u8BD5\u5DE5\u5177\u529F\u80FD").action(async (toolName) => {
    let spinner = UIProgress.spinner(`\u6B63\u5728\u51C6\u5907\u6D4B\u8BD5\u5DE5\u5177 "${toolName}"...`);
    spinner.start();
    try {
      const toolManager = await createToolManager();
      const tool = toolManager.getTool(toolName);
      if (!tool) {
        spinner.fail("\u5DE5\u5177\u4E0D\u5B58\u5728");
        UIDisplay.error(`\u5DE5\u5177 "${toolName}" \u4E0D\u5B58\u5728`);
        return;
      }
      spinner.succeed("\u6D4B\u8BD5\u51C6\u5907\u5B8C\u6210");
      UILayout.card("\u5DE5\u5177\u6D4B\u8BD5", [`\u5DE5\u5177\u540D\u79F0: ${toolName}`, `\u63CF\u8FF0: ${tool.description}`], {
        icon: "\u{1F9EA}"
      });
      const testParams = generateTestParams(tool);
      UIDisplay.info("\u751F\u6210\u7684\u6D4B\u8BD5\u53C2\u6570:");
      console.log(JSON.stringify(testParams, null, 2));
      const confirmed = await UIInput.confirm("\u786E\u8BA4\u4F7F\u7528\u8FD9\u4E9B\u53C2\u6570\u8FDB\u884C\u6D4B\u8BD5\uFF1F", { default: true });
      if (!confirmed) {
        UIDisplay.info("\u6D4B\u8BD5\u5DF2\u53D6\u6D88");
        return;
      }
      spinner = UIProgress.spinner("\u6B63\u5728\u6267\u884C\u6D4B\u8BD5...");
      spinner.start();
      const startTime = Date.now();
      const response = await toolManager.callTool({
        toolName,
        parameters: testParams
      });
      const duration = Date.now() - startTime;
      spinner.succeed(`\u6D4B\u8BD5\u5B8C\u6210 (\u8017\u65F6: ${duration}ms)`);
      UIDisplay.section("\u6D4B\u8BD5\u7ED3\u679C");
      displayToolResult(response);
    } catch (error) {
      if (spinner) spinner.fail("\u6D4B\u8BD5\u5931\u8D25");
      UIDisplay.error(`\u9519\u8BEF: ${error.message}`);
    }
  });
}
function displayToolsTable(tools) {
  UIDisplay.section("\u{1F527} \u53EF\u7528\u5DE5\u5177\u5217\u8868");
  const categories = tools.reduce(
    (acc, tool) => {
      const category = tool.category || "\u5176\u4ED6";
      if (!acc[category]) acc[category] = [];
      acc[category].push(tool);
      return acc;
    },
    {}
  );
  Object.entries(categories).forEach(([category, categoryTools]) => {
    UIDisplay.section(category);
    const toolList = categoryTools.map((tool) => {
      var _a;
      const tags = ((_a = tool.tags) == null ? void 0 : _a.length) ? ` (${tool.tags.join(", ")})` : "";
      return `${tool.name}: ${tool.description}${tags}`;
    });
    UIList.simple(toolList);
    UIDisplay.newline();
  });
  UIDisplay.info(`\u5171\u627E\u5230 ${tools.length} \u4E2A\u5DE5\u5177`);
}
function displayToolInfo(tool) {
  var _a, _b;
  UILayout.card(
    `\u5DE5\u5177\u8BE6\u60C5: ${tool.name}`,
    [
      `\u63CF\u8FF0: ${tool.description}`,
      tool.category ? `\u5206\u7C7B: ${tool.category}` : null,
      ((_a = tool.tags) == null ? void 0 : _a.length) ? `\u6807\u7B7E: ${tool.tags.join(", ")}` : null,
      tool.version ? `\u7248\u672C: ${tool.version}` : null
    ].filter(Boolean),
    { icon: "\u{1F527}" }
  );
  if (tool.inputSchema) {
    UIDisplay.section("\u8F93\u5165\u53C2\u6570");
    if (tool.inputSchema.properties) {
      const params = Object.entries(tool.inputSchema.properties).map(
        ([name, schema]) => {
          var _a2, _b2;
          const required = ((_b2 = (_a2 = tool.inputSchema) == null ? void 0 : _a2.required) == null ? void 0 : _b2.includes(name)) ? " (\u5FC5\u9700)" : " (\u53EF\u9009)";
          const type = schema.type ? ` [${schema.type}]` : "";
          const desc = schema.description ? `: ${schema.description}` : "";
          return `${name}${required}${type}${desc}`;
        }
      );
      UIList.bullets(params);
    }
  }
  if (tool.outputSchema) {
    UIDisplay.section("\u8F93\u51FA\u683C\u5F0F");
    console.log(JSON.stringify(tool.outputSchema, null, 2));
  }
  if ((_b = tool.examples) == null ? void 0 : _b.length) {
    UIDisplay.section("\u4F7F\u7528\u793A\u4F8B");
    tool.examples.forEach((example, index) => {
      UIDisplay.text(`\u793A\u4F8B ${index + 1}:`);
      console.log(JSON.stringify(example, null, 2));
      UIDisplay.newline();
    });
  }
}
function displayToolResult(response) {
  if (response.success) {
    UIDisplay.success("\u5DE5\u5177\u6267\u884C\u6210\u529F");
    if (response.data) {
      UIDisplay.section("\u6267\u884C\u7ED3\u679C");
      if (typeof response.data === "string") {
        UIDisplay.text(response.data);
      } else {
        console.log(JSON.stringify(response.data, null, 2));
      }
    }
    if (response.metadata) {
      UIDisplay.section("\u5143\u6570\u636E");
      console.log(JSON.stringify(response.metadata, null, 2));
    }
  } else {
    UIDisplay.error("\u5DE5\u5177\u6267\u884C\u5931\u8D25");
    if (response.error) {
      UIDisplay.text(`\u9519\u8BEF\u4FE1\u606F: ${response.error}`);
    }
  }
}
function generateToolDocs(tools, categories) {
  var _a;
  let docs = "# \u5DE5\u5177\u6587\u6863\n\n";
  docs += `> \u603B\u8BA1 ${tools.length} \u4E2A\u5DE5\u5177

`;
  docs += "## \u76EE\u5F55\n\n";
  for (const [category, categoryTools] of Object.entries(categories)) {
    docs += `- [${category.toUpperCase()}](#${category.toLowerCase()}) (${categoryTools.length})
`;
  }
  docs += "\n";
  for (const [category, categoryTools] of Object.entries(categories)) {
    docs += `## ${category.toUpperCase()}

`;
    for (const tool of categoryTools) {
      docs += `### ${tool.name}

`;
      docs += `${tool.description}

`;
      if (tool.version || tool.author) {
        docs += "**\u5143\u4FE1\u606F:**\n";
        if (tool.version) docs += `- \u7248\u672C: ${tool.version}
`;
        if (tool.author) docs += `- \u4F5C\u8005: ${tool.author}
`;
        docs += "\n";
      }
      if (tool.tags && tool.tags.length > 0) {
        docs += `**\u6807\u7B7E:** \`${tool.tags.join("`\u3001`")}\`

`;
      }
      docs += "**\u53C2\u6570:**\n\n";
      docs += "| \u53C2\u6570\u540D | \u7C7B\u578B | \u5FC5\u9700 | \u9ED8\u8BA4\u503C | \u63CF\u8FF0 |\n";
      docs += "|--------|------|------|--------|------|\n";
      for (const [paramName, paramSchema] of Object.entries(tool.parameters)) {
        const required = ((_a = tool.required) == null ? void 0 : _a.includes(paramName)) ? "\u2705" : "\u274C";
        const defaultValue = paramSchema.default !== void 0 ? `\`${paramSchema.default}\`` : "-";
        const description = paramSchema.description || "-";
        docs += `| \`${paramName}\` | \`${paramSchema.type}\` | ${required} | ${defaultValue} | ${description} |
`;
      }
      docs += "\n---\n\n";
    }
  }
  return docs;
}
function generateTestParams(tool) {
  const testParams = {};
  for (const [paramName, paramSchema] of Object.entries(tool.parameters)) {
    if (paramSchema.default !== void 0) {
      testParams[paramName] = paramSchema.default;
    } else if (paramSchema.enum && paramSchema.enum.length > 0) {
      testParams[paramName] = paramSchema.enum[0];
    } else {
      switch (paramSchema.type) {
        case "string":
          testParams[paramName] = "test";
          break;
        case "number":
          testParams[paramName] = 42;
          break;
        case "boolean":
          testParams[paramName] = true;
          break;
        case "array":
          testParams[paramName] = [];
          break;
        case "object":
          testParams[paramName] = {};
          break;
      }
    }
  }
  return testParams;
}

// packages/cli/src/blade.tsx
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
var BladeAppInner = ({ config, debug = false }) => {
  const [isInitialized, setIsInitialized] = useState2(false);
  const [commandOrchestrator, setCommandOrchestrator] = useState2(null);
  const [configService] = useState2(() => ConfigService.getInstance());
  const { addAssistantMessage, addUserMessage, clearMessages, resetSession } = useSession();
  const { exit } = useApp2();
  const initializeApp = useCallback2(async () => {
    try {
      await configService.initialize();
      const orchestrator = CommandOrchestrator.getInstance();
      await orchestrator.initialize();
      setCommandOrchestrator(orchestrator);
      setIsInitialized(true);
      addAssistantMessage("\u{1F680} Blade AI \u52A9\u624B\u5DF2\u542F\u52A8\uFF01\u8F93\u5165 /help \u67E5\u770B\u53EF\u7528\u547D\u4EE4\uFF0C\u6216\u76F4\u63A5\u63D0\u95EE\u3002");
    } catch (error) {
      addAssistantMessage(`\u274C \u521D\u59CB\u5316\u5931\u8D25: ${error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"}`);
    }
  }, [configService, addAssistantMessage]);
  const handleCommandSubmit = useCallback2(async (input) => {
    if (!commandOrchestrator) {
      return { success: false, error: "\u547D\u4EE4\u7F16\u6392\u5668\u672A\u521D\u59CB\u5316" };
    }
    addUserMessage(input);
    try {
      const result = input.startsWith("/") ? await commandOrchestrator.executeSlashCommand(input.slice(1).split(" ")[0], input.slice(1).split(" ").slice(1)) : await commandOrchestrator.executeNaturalLanguage(input);
      if (result.success && result.output) {
        addAssistantMessage(result.output);
      } else if (result.error) {
        addAssistantMessage(`\u274C ${result.error}`);
      }
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF";
      const result = { success: false, error: `\u6267\u884C\u5931\u8D25: ${errorMessage}` };
      addAssistantMessage(`\u274C ${result.error}`);
      return result;
    }
  }, [commandOrchestrator, addUserMessage, addAssistantMessage]);
  const handleClear = useCallback2(() => {
    clearMessages();
  }, [clearMessages]);
  const handleExit = useCallback2(async () => {
    try {
      if (commandOrchestrator) {
        await commandOrchestrator.cleanup();
      }
      resetSession();
    } catch (error) {
      console.error("\u6E05\u7406\u8D44\u6E90\u65F6\u51FA\u9519:", error);
    }
  }, [commandOrchestrator, resetSession]);
  useEffect(() => {
    if (!isInitialized) {
      initializeApp();
    }
    return () => {
      handleExit();
    };
  }, [isInitialized, initializeApp, handleExit]);
  if (!isInitialized) {
    return /* @__PURE__ */ jsxs3(Box3, { padding: 1, children: [
      /* @__PURE__ */ jsx4(Box3, { marginRight: 1, children: /* @__PURE__ */ jsx4(Text3, { children: "\u26A1" }) }),
      /* @__PURE__ */ jsx4(Text3, { children: "\u6B63\u5728\u542F\u52A8 Blade AI \u52A9\u624B..." })
    ] });
  }
  return /* @__PURE__ */ jsx4(
    EnhancedReplInterface,
    {
      onCommandSubmit: handleCommandSubmit,
      onClear: handleClear,
      onExit: () => exit()
    }
  );
};
var BladeApp = (props) => /* @__PURE__ */ jsx4(ErrorBoundary2, { children: /* @__PURE__ */ jsx4(SessionProvider, { children: /* @__PURE__ */ jsx4(BladeAppInner, { ...props }) }) });
async function main() {
  const program = new Command();
  program.version("1.3.0", "-v, --version", "\u663E\u793A\u5F53\u524D\u7248\u672C").description("Blade AI - \u667A\u80FDAI\u52A9\u624B\u547D\u4EE4\u884C\u754C\u9762").option("-d, --debug", "\u542F\u7528\u8C03\u8BD5\u6A21\u5F0F");
  agentLlmCommand(program);
  configCommand(program);
  llmCommand(program);
  mcpCommand(program);
  toolsCommand(program);
  program.action((options) => {
    render(React4.createElement(BladeApp, { debug: options.debug }));
  });
  await program.parseAsync(process.argv);
  if (program.args.length === 0 && !program.matchedCommand) {
    render(React4.createElement(BladeApp, { debug: program.opts().debug }));
  }
}

// packages/cli/index.ts
process.on("unhandledRejection", (reason, promise) => {
  console.error("\u274C \u53D1\u751F\u4E86\u672A\u5904\u7406\u7684 Promise Rejection:");
  console.error(reason);
});
process.on("uncaughtException", (error) => {
  console.error("\u274C \u53D1\u751F\u4E86\u672A\u6355\u83B7\u7684\u5F02\u5E38:");
  console.error(error);
  process.exit(1);
});
async function run() {
  try {
    await main();
  } catch (error) {
    console.error("\u274C \u5E94\u7528\u542F\u52A8\u5931\u8D25:");
    console.error(error);
    process.exit(1);
  }
}
run();
//# sourceMappingURL=blade.js.map
