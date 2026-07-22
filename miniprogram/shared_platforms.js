/**
 * 平台显示名 + 主题色。Web / MP 共用，避免手抄两份。
 * 与 server/config 中的平台定义保持一致。
 */
const PLATFORM_INFO = {
  aliyun: { name: '阿里云盘', color: '#ff6a00' },
  quark: { name: '夸克网盘', color: '#1677ff' },
  baidu: { name: '百度网盘', color: '#06a7ff' },
  '115': { name: '115 网盘', color: '#2b82b9' },
  xunlei: { name: '迅雷云盘', color: '#0070f3' },
  tianyi: { name: '天翼云盘', color: '#4ba0eb' },
  '123': { name: '123 网盘', color: '#3b82f6' },
  uc: { name: 'UC 网盘', color: '#ed3f3f' },
  others: { name: '其他', color: '#9ca3af' }
}

module.exports = { PLATFORM_INFO }
