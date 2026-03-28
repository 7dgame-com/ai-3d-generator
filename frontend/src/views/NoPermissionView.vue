<template>
  <div class="no-permission-container">
    <el-result
      icon="error"
      title="没有访问权限"
      sub-title="您没有使用此插件的权限，请联系管理员"
    />
  </div>
</template>

<style scoped>
.no-permission-container {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
}
</style>
