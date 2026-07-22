App({
  globalData: {
    apiBase: 'https://panhub.shenzjd.com',
    mpClientSecret: ''
  },
  onLaunch() {
    const token = wx.getStorageSync('panhub_token')
    if (token) {
      this.globalData.mpClientSecret = token
    }
  }
})
