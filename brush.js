#!/usr/bin/env node

/**
 * brush.js
 *
 * A one‐file Node.js CLI to apply an OpenAI‐based refactoring prompt to a set of files.
 *
 * Usage:
 *   brush --config=brush.config.json
 *
 * Config (brush.config.json) should contain:
 * {
 *   "patterns": ["src/*.js", "lib/*.ts"],
 *   "ignore": ["node_modules/**", "dist/**"],
 *   "dryRun": true,                // if true, only process the first matching file and print result
 *   "model": "gpt-4o-mini",        // any OpenAI model name
 *   "intervalMilis": 1000          // number of milliseconds to wait between API calls
 * }
 *
 * You must also provide two markdown files at the root:
 *   brush.system.md   – the “system” prompt
 *   brush.prompt.md   – the “user” prompt template; use {{ CONTENT }} to interpolate file contents
 *
 * Environment:
 *   OPENAI_API_KEY must be set (e.g. export OPENAI_API_KEY="sk-...")
 */

const fs = require("fs/promises");
const path = require("path");
const glob = require("fast-glob");
const { OpenAI } = require("openai");

// --- Helper: parse “--config=...” from process.argv
function parseConfigArg() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--config=")) {
      return arg.split("=")[1];
    }
  }
  console.error("Usage: brush --config=brush.config.json");
  process.exit(1);
}

async function main() {
  // 1. Read CLI arg
  const configPath = parseConfigArg();

  // 2. Load JSON config
  let config;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read or parse config file at "${configPath}":`, err.message);
    process.exit(1);
  }

  const { patterns = [], ignore = [], dryRun = false, model = "gpt-3.5-turbo", intervalMilis = 1000 } = config;

  if (!Array.isArray(patterns) || patterns.length === 0) {
    console.error(`"patterns" must be a non‐empty array in ${configPath}`);
    process.exit(1);
  }

  // 3. Load brush.system.md and brush.prompt.md (in current working dir)
  const cwd = process.cwd();
  const systemPromptPath = path.join(cwd, "brush.system.md");
  const userPromptTemplatePath = path.join(cwd, "brush.prompt.md");

  let systemPrompt, userPromptTemplate;
  try {
    systemPrompt = await fs.readFile(systemPromptPath, "utf-8");
  } catch (err) {
    console.error(`Failed to read system prompt file at "${systemPromptPath}":`, err.message);
    process.exit(1);
  }
  try {
    userPromptTemplate = await fs.readFile(userPromptTemplatePath, "utf-8");
  } catch (err) {
    console.error(`Failed to read user prompt file at "${userPromptTemplatePath}":`, err.message);
    process.exit(1);
  }

  // 4. Find all matching files via fast-glob
  let entries;
  try {
    entries = await glob(patterns, {
      ignore,
      onlyFiles: true,
      dot: false,
      cwd,
      absolute: true,
    });
  } catch (err) {
    console.error("Error during file globbing:", err.message);
    process.exit(1);
  }

  if (entries.length === 0) {
    console.log("No files matched. Exiting.");
    process.exit(0);
  }

  // 5. Initialize OpenAI client
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Environment variable OPENAI_API_KEY is not set.");
    process.exit(1);
  }
  const openai = new OpenAI({ apiKey });

  // 6. Helper to send one file to OpenAI
  async function processFile(filePath) {
    const relative = path.relative(cwd, filePath);
    let content;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      console.error(`  [ERROR] Could not read "${relative}": ${err.message}`);
      return null;
    }

    // Replace placeholder {{ CONTENT }} in user prompt template
    const userPrompt = userPromptTemplate.replace(/{{\s*CONTENT\s*}}/g, content);

    try {
      const resp = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      if (resp.choices && Array.isArray(resp.choices) && resp.choices.length > 0) {
        const output = resp.choices[0].message.content;
        return output;
      } else {
        console.error(`  [ERROR] OpenAI returned status ${resp.status} for "${relative}"`);
        return null;
      }
    } catch (err) {
      console.error(`  [ERROR] OpenAI request failed for "${relative}":`, err.message);
      return null;
    }
  }

  // 7. Iterate through all matched files
  console.log(`Found ${entries.length} file(s). ${dryRun ? "Dry‐run is ON (only first file will be processed)." : ""}`);

  for (const filePath of entries) {
    const relative = path.relative(cwd, filePath);
    console.log(`\nProcessing: ${relative}`);

    const result = await processFile(filePath);
    if (result === null) {
      console.error(`  Skipping "${relative}" due to errors.`);
      if (dryRun) process.exit(1);
      else continue;
    }

    if (dryRun) {
      console.log("----- DRY RUN OUTPUT (first file only) -----\n");
      console.log(result);
      console.log("\n--------------------------------------------");
      process.exit(0);
    }

    // Overwrite the file with the response
    try {
      await fs.writeFile(filePath, result, "utf-8");
      console.log(`  [OK] Overwrote "${relative}".`);
    } catch (err) {
      console.error(`  [ERROR] Failed to write "${relative}":`, err.message);
    }

    // Wait intervalMilis before next call (unless this was the last file)
    await new Promise((res) => setTimeout(res, intervalMilis));
  }

  console.log("\nAll done.");
}

main();
