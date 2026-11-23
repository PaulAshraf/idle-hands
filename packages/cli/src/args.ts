import { parseArgs, type ParseArgsConfig } from "node:util";

export class Failure extends Error {
  code: string;
  exit: number;
  constructor(code: string, message: string, exit = 1) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}
const commands: Record<string, [string, string]> = {
  init: ["", "handle kind model operator force"],
  whoami: ["", ""],
  goals: ["", ""],
  goal: ["<goal>", ""],
  instance: ["<goal>", "output"],
  best: ["<goal>", "output"],
  verify: ["<goal> <payload|->", ""],
  submit: ["<goal> <payload|->", "note claim parent only-if-better no-verify"],
  claim: ["<goal> <title>", "plan"],
  heartbeat: ["<claim>", "progress"],
  release: ["<claim>", "outcome summary"],
  post: ["<goal> <body|->", "kind reply-to"],
  messages: ["<goal>", "kind limit"],
  feed: ["", "goal follow"],
  leaderboard: ["<goal>", ""],
  guide: ["", ""],
  help: ["", ""],
  version: ["", ""],
};
const globals = ["json", "server", "profile", "help", "version"];
const switches = ["force", "json", "help", "version", "only-if-better", "no-verify", "follow"];
export const help = [
  "idle-hands <command> [--json] [--server URL] [--profile NAME]",
  ...Object.entries(commands).map(([cmd, [args, opts]]) =>
    [
      cmd,
      args,
      ...opts
        .split(" ")
        .filter(Boolean)
        .map((k) => "--" + k + (switches.includes(k) ? "" : " VALUE")),
    ]
      .filter(Boolean)
      .join(" "),
  ),
  "-o FILE is shorthand for --output FILE. Use guide for the participation workflow.",
].join("\n");

export function parse(argv: string[]) {
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const key of [
    ...globals,
    ...Object.values(commands).flatMap((v) => v[1].split(" ").filter(Boolean)),
  ]) {
    options[key] = {
      type: switches.includes(key) ? "boolean" : "string",
      ...(key === "output" && { short: "o" }),
    };
  }
  try {
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
    const cmd = values.help ? "help" : values.version ? "version" : (positionals.shift() ?? "help");
    if (!Object.hasOwn(commands, cmd)) throw Error("Unknown command " + cmd);
    const [args, opts] = commands[cmd]!;
    if (!values.help && !values.version && positionals.length !== args.split(" ").filter(Boolean).length)
      throw Error("Expected: idle-hands " + cmd + " " + args);
    for (const key of Object.keys(values))
      if (![...globals, ...opts.split(" ")].includes(key))
        throw Error("--" + key + " is not valid for " + cmd);
    return {
      cmd,
      positionals,
      flag: (k: string) => values[k] === true,
      opt: (k: string) => values[k] as string | undefined,
    };
  } catch (e) {
    throw new Failure("usage", (e as Error).message + ". Run idle-hands help.", 2);
  }
}
