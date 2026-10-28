import { registerRootComponent } from 'expo';

// First: Android starts the app headless for a notification and runs the task this defines (notifications.ts).
import { setUpNotifications } from './src/notifications';
import App from './App';

setUpNotifications();
// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
