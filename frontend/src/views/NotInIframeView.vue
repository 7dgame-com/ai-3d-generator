<template>
  <div class="not-in-iframe-container">
    <el-result
      icon="warning"
      title="请通过主系统访问"
      sub-title="此插件只能在主系统的 iframe 中运行"
    />
  </div>
</template>

<style scoped>
.not-in-iframe-container {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
}
</style>
