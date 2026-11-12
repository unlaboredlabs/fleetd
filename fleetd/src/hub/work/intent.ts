// New work as the matcher reads it at a writer's spawn: held by
// its project, with its PR declared. The tasks area reaches it as `work(hub).matcher.intent`.
import type { ProjectRef } from "../../shared/contracts.ts";
import { matcherKeys, matcherScope, projectOwner } from "./check.ts";
import { declared, From, readWork, sameKey, type Work } from "./matcher.ts";
import type { WorkScope } from "./repo_key.ts";

export function intent(project: ProjectRef, scope: WorkScope, title: string, prompt: string, pr: string | undefined, paths: Iterable<string>): Work {
  const ms = matcherScope(scope);
  const work = readWork(projectOwner(project), title, prompt, ms);
  for (const key of pr !== undefined ? matcherKeys({ pr }, ms) : []) {
    const known = work.keys.find((k) => sameKey(k.key, key));
    if (known) known.from = From.Declared;
    else work.keys.push(declared(key));
  }
  work.paths.push(...paths);
  return work;
}
