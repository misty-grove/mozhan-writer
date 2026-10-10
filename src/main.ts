import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/global.css'
import { installSaveGuards } from './stores/workspace'

// 先把「离开前把稿子写下去」的守卫装好，再挂载界面：
// 万一挂载过程中出错，至少关窗保护是生效的。
installSaveGuards()

createApp(App).use(createPinia()).mount('#app')
