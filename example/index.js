// Stub entry point for the example app. The example app exists only
// to compile the lib's Kotlin sources via Gradle; it doesn't actually
// run as an app. Real consumers are MOBILE_APP_REACT_NATIVE and any
// downstream integration that uses @simba-dev/react-native-media-player.

import { AppRegistry } from 'react-native';
import App from './App';

AppRegistry.registerComponent('SimbaMediaPlayerExample', () => App);
