#!/usr/bin/env node

// src/index.ts
import chalk2 from "chalk";
import { Command } from "commander";

// src/commands/init.ts
import chalk from "chalk";
import fs from "fs";
import inquirer from "inquirer";
import path from "path";
function initCommand(program2) {
  program2.command("init").description("\u521D\u59CB\u5316\u4E00\u4E2A\u65B0\u9879\u76EE").argument("[name]", "\u9879\u76EE\u540D\u79F0").option("-t, --template <template>", "\u4F7F\u7528\u7684\u6A21\u677F", "default").action(async (name, options) => {
    console.log(chalk.blue("\u{1F680} \u5F00\u59CB\u521D\u59CB\u5316\u9879\u76EE..."));
    if (!name) {
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "projectName",
          message: "\u8BF7\u8F93\u5165\u9879\u76EE\u540D\u79F0:",
          default: "my-project"
        }
      ]);
      name = answers.projectName;
    }
    if (options.template === "default") {
      const answers = await inquirer.prompt([
        {
          type: "list",
          name: "template",
          message: "\u8BF7\u9009\u62E9\u9879\u76EE\u6A21\u677F:",
          choices: ["react", "vue", "node"]
        }
      ]);
      options.template = answers.template;
    }
    const projectPath = path.resolve(process.cwd(), name);
    if (fs.existsSync(projectPath)) {
      const { overwrite } = await inquirer.prompt([
        {
          type: "confirm",
          name: "overwrite",
          message: `\u76EE\u5F55 ${name} \u5DF2\u5B58\u5728\uFF0C\u662F\u5426\u8986\u76D6?`,
          default: false
        }
      ]);
      if (!overwrite) {
        console.log(chalk.yellow("\u274C \u64CD\u4F5C\u5DF2\u53D6\u6D88"));
        return;
      }
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
    fs.mkdirSync(projectPath, { recursive: true });
    const packageJson = {
      name,
      version: "0.1.0",
      description: `${name} project created by agent-cli`,
      type: "module",
      main: "index.js",
      scripts: {
        start: "node index.js"
      },
      keywords: [],
      author: "",
      license: "MIT"
    };
    fs.writeFileSync(
      path.join(projectPath, "package.json"),
      JSON.stringify(packageJson, null, 2)
    );
    fs.writeFileSync(
      path.join(projectPath, "index.js"),
      `console.log('Hello from ${name}!');
`
    );
    console.log(chalk.green(`\u2705 \u9879\u76EE ${name} \u5DF2\u6210\u529F\u521B\u5EFA!`));
    console.log(chalk.cyan(`\u6A21\u677F: ${options.template}`));
    console.log(chalk.cyan(`\u4F4D\u7F6E: ${projectPath}`));
    console.log("");
    console.log(chalk.yellow("\u63A5\u4E0B\u6765:"));
    console.log(`  cd ${name}`);
    console.log("  npm install");
    console.log("  npm start");
  });
}

// src/index.ts
var program = new Command();
program.name("agent").description("\u4E00\u4E2A\u529F\u80FD\u5F3A\u5927\u7684 CLI \u5DE5\u5177").version("1.0.0");
initCommand(program);
program.on("--help", () => {
  console.log("");
  console.log(chalk2.green("\u793A\u4F8B:"));
  console.log("  $ agent init myproject");
});
program.parse(process.argv);
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
