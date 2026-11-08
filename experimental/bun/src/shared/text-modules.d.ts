// `import sql from "x.sql" with { type: "text" }`: Bun reads the file as text, and `bun build --compile` embeds it.
declare module "*.sql" {
  const text: string;
  export default text;
}

// `import rs from "x.rs" with { type: "text" }`: a Rust source read for a constant both builds share.
declare module "*.rs" {
  const text: string;
  export default text;
}

// `import sh from "x.sh" with { type: "text" }`: a script the hub renders and hands a machine.
declare module "*.sh" {
  const text: string;
  export default text;
}
