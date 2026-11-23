// `import sql from "x.sql" with { type: "text" }`: Bun reads the file as text, and `bun build --compile` embeds it.
declare module "*.sql" {
  const text: string;
  export default text;
}

// `import js from "x.mjs" with { type: "text" }`: a script the node writes out and runs under Node.js.
declare module "*.mjs" {
  const text: string;
  export default text;
}

// `import sh from "x.sh" with { type: "text" }`: a script the hub renders and hands a machine.
declare module "*.sh" {
  const text: string;
  export default text;
}

// `import recipe from "x/Dockerfile" with { type: "text" }`: an image recipe the node hashes into its pin.
declare module "*/Dockerfile" {
  const text: string;
  export default text;
}

// `import path from "x.c" with { type: "file" }`: Bun gives the file's path (embedded by `bun build --compile`).
declare module "*.c" {
  const path: string;
  export default path;
}

// `import path from "x.swift" with { type: "file" }`: a helper the node compiles on the agents' Mac.
declare module "*.swift" {
  const path: string;
  export default path;
}
