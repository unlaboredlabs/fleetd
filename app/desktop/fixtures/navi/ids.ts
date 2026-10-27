// navi-two's Navis (fixtures/navi), shared with the QA registry.
export const ADA = { machineId: "devbox", projectId: "6dd9376b-4709-44a8-869e-fb5645046d52" } as const;
export const HOME = { machineId: "devbox", projectId: "b9c1435a-fb02-4e0a-87ce-9d5e779c55a2" } as const;
export const TAXES = { machineId: "devbox", projectId: "daa6878e-1e3b-487d-8851-ea82b172a2cc" } as const;

/** Ada's chat. */
export const ADA_ROUTE = `#/project/${ADA.machineId}/${ADA.projectId}`;
