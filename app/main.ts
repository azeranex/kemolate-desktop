import { createApp } from 'vue'

import App from './App.vue'
import { nuxtReady } from './composables/nuxt'
// vue-sonner stopped bundling its own styles at v2 — without this the toasts
// render, unstyled and stacked, in the corner of the page. Before the theme, as
// in the web build's nuxt.config, so the theme's rules win where they meet.
import 'vue-sonner/style.css'
import './assets/css/tailwind.css'
// The page's own faces, after the interface's — as in the web build's
// nuxt.config; see the header of `fonts.css`.
import './assets/css/fonts.css'

// Light or dark is `useColorScheme`'s, set during the app's own setup — before
// the first paint, since its choice is read synchronously from local storage.
createApp(App).mount('#app')

// And now the app is up — see `onNuxtReady` in `composables/nuxt.ts`, which the
// saved settings wait on to be read in and watched for good.
nuxtReady()
