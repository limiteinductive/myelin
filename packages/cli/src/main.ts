#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DEFAULT_PORT, importStudyModeFile, invite, loadEnv, up } from "./commands.js";

const HELP = `myelin <command>

  up [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--data DIR] [--name me]
                                 Run the server and web app locally
  invite <name> [--url URL] [--data DIR]
                                 Make a user, or a new device link for one, and print a one-time link
  import study-mode <path> [--user NAME] [--data DIR]
                                 Import a study-mode memory.jsonl

The data directory defaults to $MYELIN_DATA or ~/.myelin/data. The tutor needs a model key:
GEMINI_API_KEY for the default model, MYELIN_MODEL (provider/model) for another. Both may go in .env.`;

async function main(argv: string[]): Promise<number> {
  loadEnv();
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      data: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      user: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }
  switch (command) {
    case "up": {
      const port = values.port ? Number(values.port) : undefined;
      const srv = await up({ port, host: values.host, data: values.data, name: values.name });
      const stop = () => void srv.close().then(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return new Promise<number>(() => {});
    }
    case "invite": {
      const name = rest.join(" ");
      if (!name) throw new Error("usage: myelin invite <name>");
      const r = invite(name, { data: values.data, url: values.url });
      console.log(r.created ? `Made a user, ${r.user.name}.` : `${r.user.name} already exists. This link signs in one more device.`);
      console.log(`One-time sign-in link (valid for 7 days): ${r.link}`);
      return 0;
    }
    case "import": {
      const [kind, path] = rest;
      if (kind !== "study-mode" || !path) throw new Error("usage: myelin import study-mode <path>");
      const r = importStudyModeFile(path, { data: values.data, user: values.user });
      console.log(`Imported into ${r.user.name}'s record: ${r.added} new events, ${r.skipped} already there.`);
      return 0;
    }
    default:
      console.error(`unknown command ${command}\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
