const fs = require("fs");
const path = require("path");
const { validateEvent } = require("./validator");

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const sanitized = raw.replace(/^\uFEFF/, "");
  return JSON.parse(sanitized);
}

function main() {
  const argPath = process.argv[2];

  if (!argPath) {
    console.error("Usage: npm run validate -- <path-to-json>");
    process.exit(1);
  }

  const fullPath = path.resolve(argPath);
  const parsed = readJson(fullPath);

  const events = Array.isArray(parsed) ? parsed : [parsed];

  let failures = 0;

  events.forEach((event, index) => {
    const result = validateEvent(event);
    if (!result.valid) {
      failures += 1;
      console.error(`Event[${index}] INVALID`);
      result.errors.forEach((e) => console.error(`  - ${e}`));
    } else {
      console.log(`Event[${index}] VALID (${event.type}, ${event.id})`);
    }
  });

  if (failures > 0) {
    process.exit(2);
  }
}

main();
