// Add project and Machines: the public surface. Other screens import from "../projects", never the files inside.
//
// Entry points: the sidebar's "+ Add", the empty board and the File menu call openAddProject() (or go to
// #/projects/add); the palette's "Add project…" is registered by <ProjectsHost/>, which the shell mounts once and
// which also takes folders and GitHub links dropped on the window. The sidebar's project menu can use
// <RemoveProjectDialog/>.
export { AddProjectScreen } from "./AddProjectScreen";
export { MachinesScreen } from "./MachinesScreen";
export { ProjectsHost } from "./ProjectsHost";
export { RemoveProjectDialog, type RemoveTarget } from "./RemoveProjectDialog";
export { ADD_ROUTE, openAddProject } from "./store";
