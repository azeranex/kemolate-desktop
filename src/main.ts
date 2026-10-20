import { createApp } from 'vue'

import App from './App.vue'
// vue-sonner stopped bundling its own styles at v2 — without this the toasts
// render, unstyled and stacked, in the corner of the page. Before the theme, as
// in the web build's nuxt.config, so the theme's rules win where they meet.
import 'vue-sonner/style.css'
import './assets/css/tailwind.css'

// Light or dark is `useColorScheme`'s, set during the app's own setup — before
// the first paint, since its choice is read synchronously from local storage.
createApp(App).mount('#app')
