const auth = require('../../utils/auth.js')

Page({
  data: {
    unlocked: false
  },

  onShow() {
    this.setData({ unlocked: !!auth.getToken() })
  },

  onLogout() {
    auth.clearToken()
    this.setData({ unlocked: false })
    wx.showToast({ title: '已退出解锁', icon: 'none' })
  }
})
