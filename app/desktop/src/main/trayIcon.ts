// The menu bar's icon (menuBar.ts): the app's face, Pebble's silhouette with its eyes cut out, as a macOS template
// image (black, its alpha the shape, which macOS tints for a light or dark menu bar and the open state). 18 pt square
// at 1x and 2x, Pebble 14 pt wide. Rendered from app/icon/silhouette.svg by `npm run icons` in app/mobile.
import { nativeImage, type NativeImage } from "electron";

const AT_1X = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABAElEQVR4nL3QgU3CQBiG4e8msE6gTiBOYJ1ANwAnsE7gMYF1AmEDN7CdQJhAN7BMoO9Pc22PlKYkhDd50oTQL3d1OlInG5rgDNYGK/S2b+gBr7hU3I+kZ3wgymG3d8w03ELSI5ocunlJLxiTnSzHtu5Qgm/Yc0wVrmDPaCiDfZdDak7VHSok3cJaYqHaBaw1MswkTWGVSEUOoS9MYJ2jglf7zebwqq/+C2uFG0RDfwiF33M8wXpDBiv8d4MEzQtWofZqGUp8IoFV4Q738KorkYocQl7tNcY2hxc5hBIUkq4xpjVS1SeNhqwEOaYYaokMFbY57CtVf4V6Gho6qKMN/QNvTy4Tveaw8wAAAABJRU5ErkJggg==";
const AT_2X = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAB5ElEQVR4nO3V7XWaYByG8fuZIGSC0g3coGSC4gY4QegEpRuYCcoG6gTFCWoniJlAMkF6cZ760sc/oInk5IPXOb9vireA6PTBug7q6zqor7cM+oJEUiyvaS2vkrTE2TmcU4R75IjQVY0pHlDjpM4Z1Awp1D8krEYhP6y3Uwf9RKa3VUqaoDOHvi4xZlupnlEOXU3RXKpL1ly6HGZdgxJJvzBEd6hk5NDWI2IN01rSZxzlYJXJ3ztDNkGpIAer3xhhyBZI8V/WoAgbvEe3qLHLGpSp/XItMMUIhaQbWD2jkLRCjq+wGmOOXdagQtJ3hC2QYlum9uETlNo3hzXqBwod5BBWyf9xho3RHHhbhA2sblFjW4oZwpZIdJBDWCV7UPghTS+wCo8bYYOwJRId5BD2iFjHOYS9wOrU1/7BCLusN1Y67Qwlan+S36HSvgivPkOV7EETlNo3QwqrOcbYlsn+ASyR6CCHsCnuEVYjx1p+SI6uCvkvF8sfM0LYA3LscghLMcN7NMYcu6xBTWtJnzBkT4gV5GCVYuizdHR2mtoGNRWyn9iX6BumOKprUFMm/8YbXKJn5CjVUt+gpgg5Mr3+vnpCKf/larTmcE6x/HMjlh86gtUKNVb/rHViDh+q66C+roP6+gvl414lg7FcEgAAAABJRU5ErkJggg==";

export const trayIcon = (): NativeImage => {
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, dataURL: AT_1X });
  image.addRepresentation({ scaleFactor: 2, dataURL: AT_2X });
  image.setTemplateImage(true);
  return image;
};
