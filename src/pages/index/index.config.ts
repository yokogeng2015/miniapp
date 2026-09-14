export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '单词随拍默写' })
  : { navigationBarTitleText: '单词随拍默写' }