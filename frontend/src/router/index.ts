import { createRouter, createWebHistory } from 'vue-router'
import { isInIframe, getToken } from '../utils/token'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/not-in-iframe',
      name: 'NotInIframe',
      component: () => import('../views/NotInIframeView.vue'),
      meta: { title: '请通过主系统访问' }
    },
    {
      path: '/no-permission',
      name: 'NoPermission',
      component: () => import('../views/NoPermissionView.vue'),
      meta: { title: '无权限' }
    },
    {
      path: '/',
      name: 'Generator',
      component: () => import('../views/GeneratorView.vue'),
      meta: { title: 'AI 3D 生成器', requiresAuth: true }
    },
    {
      path: '/history',
      name: 'History',
      component: () => import('../views/HistoryView.vue'),
      meta: { title: '历史记录', requiresAuth: true }
    },
    {
      path: '/admin',
      name: 'Admin',
      component: () => import('../views/AdminView.vue'),
      meta: { title: '管理员配置', requiresAuth: true }
    }
  ]
})

router.beforeEach((to) => {
  // 非 iframe 环境重定向到 /not-in-iframe
  if (to.path !== '/not-in-iframe' && !isInIframe()) {
    return { name: 'NotInIframe' }
  }

  // 受保护路由需要 token，无 token 重定向到 /no-permission
  if (to.meta.requiresAuth && !getToken()) {
    return { name: 'NoPermission' }
  }

  return true
})

export default router
