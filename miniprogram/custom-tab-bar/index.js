/**
 * 自定义 TabBar —— 对齐设计稿：icon 上 / label 下竖排，
 * 选中态微信绿 #07C160，未选中 #999999。
 */
const svg = (body, color) =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none">' + body(color) + '</svg>'
  )

const ICONS = {
  search: {
    on: svg(c => '<circle cx="11" cy="11" r="7" stroke="' + c + '" stroke-width="2.2"/><path d="M16.5 16.5L21 21" stroke="' + c + '" stroke-width="2.2" stroke-linecap="round"/>', '#07C160'),
    off: svg(c => '<circle cx="11" cy="11" r="7" stroke="' + c + '" stroke-width="2"/><path d="M16.5 16.5L21 21" stroke="' + c + '" stroke-width="2" stroke-linecap="round"/>', '#999999')
  },
  hot: {
    on: svg(() => '<path d="M12 21C7.6 21 4 17.9 4 13.9C4 10.5 6.9 8 8.5 6.2C9 5.7 10 5.8 10.2 6.6C10.4 7.4 10.2 8.3 10.6 9C11 8 11.6 6.7 11.5 5C11.4 4.1 12.3 3.7 13 4.3C15.5 6.6 20 9.8 20 13.9C20 17.9 16.4 21 12 21Z" fill="#07C160"/><path d="M12 21C10.1 21 8.5 19.6 8.5 17.7C8.5 16 9.7 14.7 10.8 13.5C11.1 13.1 11.8 13.2 11.9 13.8C12.1 14.5 12 15.1 12.3 15.7C12.7 14.8 13.1 13.8 13.1 12.3C13.1 11.2 14.2 10.7 14.8 11.5C15.8 12.9 16.3 14.4 16.3 15.6C16.3 18.1 14.5 21 12 21Z" fill="#06AD56"/>', '#07C160'),
    off: svg(() => '<path d="M12 21C7.6 21 4 17.9 4 13.9C4 10.5 6.9 8 8.5 6.2C9 5.7 10 5.8 10.2 6.6C10.4 7.4 10.2 8.3 10.6 9C11 8 11.6 6.7 11.5 5C11.4 4.1 12.3 3.7 13 4.3C15.5 6.6 20 9.8 20 13.9C20 17.9 16.4 21 12 21Z" fill="#999999"/><path d="M12 21C10.1 21 8.5 19.6 8.5 17.7C8.5 16 9.7 14.7 10.8 13.5C11.1 13.1 11.8 13.2 11.9 13.8C12.1 14.5 12 15.1 12.3 15.7C12.7 14.8 13.1 13.8 13.1 12.3C13.1 11.2 14.2 10.7 14.8 11.5C15.8 12.9 16.3 14.4 16.3 15.6C16.3 18.1 14.5 21 12 21Z" fill="#C7C7C7"/>', '#999999')
  },
  settings: {
    on: svg(c => '<circle cx="12" cy="12" r="3.2" stroke="' + c + '" stroke-width="1.8"/><path d="M12 2.5V5M12 19V21.5M21.5 12H19M5 12H2.5M18.4 5.6L16.7 7.3M7.3 16.7L5.6 18.4M18.4 18.4L16.7 16.7M7.3 7.3L5.6 5.6" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round"/>', '#07C160'),
    off: svg(c => '<circle cx="12" cy="12" r="3.2" stroke="' + c + '" stroke-width="1.8"/><path d="M12 2.5V5M12 19V21.5M21.5 12H19M5 12H2.5M18.4 5.6L16.7 7.3M7.3 16.7L5.6 18.4M18.4 18.4L16.7 16.7M7.3 7.3L5.6 5.6" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round"/>', '#999999')
  }
}

Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '搜索', iconOn: ICONS.search.on, iconOff: ICONS.search.off },
      { pagePath: '/pages/hot/hot', text: '热搜', iconOn: ICONS.hot.on, iconOff: ICONS.hot.off },
      { pagePath: '/pages/settings/settings', text: '设置', iconOn: ICONS.settings.on, iconOff: ICONS.settings.off }
    ]
  },
  methods: {
    switchTab(e) {
      const { path, index } = e.currentTarget.dataset
      if (index === this.data.selected) return
      wx.switchTab({ url: path })
    }
  }
})
