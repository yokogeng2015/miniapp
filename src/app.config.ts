export default defineAppConfig({
  pages: [
    'pages/index/index'
  ],
  // 微信隐私保护：开启后调用相册/相机等隐私接口会触发官方隐私授权弹窗
  // 前提：需在小程序后台「设置 → 服务内容声明 → 用户隐私保护指引」声明对应权限
  __usePrivacyCheck__: true,
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#fff',
    navigationBarTitleText: 'WeChat',
    navigationBarTextStyle: 'black'
  }
})
