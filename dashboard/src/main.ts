import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import './base.css';
import './blueprint.css';

createApp(App).use(router).mount('#app');
