// The menu bar's icon (menuBar.ts): the app's mark, its three chevrons, as a macOS template image (black, its alpha
// the shape, which macOS tints for a light or dark menu bar and the open state). 18 pt square at 1x and 2x: the
// chevrons span 14.5 pt and stand 8.5 pt, stroked 2 pt at 1x and 1.8 pt at 2x with round ends, at the mark's own
// .45 / .72 / 1 steps of opacity.
import { nativeImage, type NativeImage } from "electron";

const AT_1X = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABNUlEQVR4nK3UzypFURTH8c/1595cGV1/BigpnsGfofICTAh5DBNlgHgAAwa6Qp5A8QYGeAoDI0W5SnQN7jrX7kjEXbU7+/zOPt/zW2vtfWhxFGL8pLXF+BXwN9q3sF6Uci8OoxLz9riOYCynNaMfa1hBObQKLnCGwdC6cY8nTIbWkVp8xh1GMRewZ9zG13cwhBou0YNzTOEthUEXlrGBRRTRiU1co4q+WFtFHQ+YTtMsJLDVgC1o1KyI3XB3iIEc7BETqaMM1o0lrGM+Ui9jC1fYjzUF7CXOxvNtfMN7zLPcX2PUw2Eh5rV4XsrWpqlldco6WAw3NzjV2BJwELAXzKROUshy3Hf4LPaJRufy9ZkNrT2tSwYph93tgBwnkCNfO9Zsf0s2ZBYtOSJp/PvQtvw38uf4AJF5PuE+QIaIAAAAAElFTkSuQmCC";
const AT_2X = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAADE0lEQVR4nO2Xy2oUQRSGv+6ZySQxxKgJIi5c+QJeQVREX0GMuBTETaIuRLxm4SVRVBCNILhWEt/AhUgwiivfQkSiMQkhFzMz7aL+Q1fampkOIRAlB5qq7q7u881/LjUNG7Zh/7FFQKyxmcU6mllBx6otDxQ0horqzHNbG7AbaK3zksgbDwC7GkDZ2sPAMe9aLrAIaAfOAreA80BPwJmF6SrwGXgLnNA9Pyw2vwQkOp569xpCxXpgB7ATmAK6gF5B1UjzqgZsBo4DP/XcTUFVPZBE4zldXwT6gWc6b5inpsB3YAKn1LxGH8rknsGps0WOFgNQ5uy1d74E9OWBshuzwBtgGpdLCwGoWOMgMAZsA34HoKxa7wHDQIt85YKykEXAJDASgDolRewlC8AA8AHYmoE6AlRI861fUKW8UBayRPOpAFSHlOoiDctSHagB4JAHVVgplF9FFhaDmhHUPC6ZT9eBGhfUot5x24OKVgoVSizLlW5BtEupNik3ImhbVwYeAHuBXzovCPYTafVVBdAnIAQ4LOAYSEJNzZT6AYxKIQvfZlz4OrWuIGWuAV9IE70qpfZrjqfUc4HEnlJP9L6oXus3qAnglZQpCaobOOqtiwR9BfgIbBJUJIAWrUuAogAeCjDGhfYiLsy1PBtk1qwAzOo1uYS0D1nHNpsNrC8h4pBZfvSwPI/KOLXGvXVVXEjvA/tw7aOo4wUupJZHFWAIt/1U5aOEy60xIA4p5MP0klZaGZjDNdBJOTGYIWAPbksp4TboO7i24Ce1wVQ8mGHggvwmWbmzMKZMq2BGcXmVhbEKaxH4XeCdVEpoXmEF+V1WZXlhimsFYxCQ7uZ5lKmsAiYSzOMQjAFZFeSBqeHKerAJTK2OMkX9kMshGF+hDuCknIVgLJz2B+0gLrGzMAU5qAE3BGM9qSSY6x70MhgDSoDtuIY3p3BkYayPdArGtogsTNVzcsY7N2UMxl/3F1AEfAO+4jbPqYAy1gyngfe4LSIKwEDaKF/qehl4lAcma2v9Jz/vJ1bQ1sVn0Lr+UNywDftn7Q9PWh/ppAQjEAAAAABJRU5ErkJggg==";

export const trayIcon = (): NativeImage => {
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, dataURL: AT_1X });
  image.addRepresentation({ scaleFactor: 2, dataURL: AT_2X });
  image.setTemplateImage(true);
  return image;
};
