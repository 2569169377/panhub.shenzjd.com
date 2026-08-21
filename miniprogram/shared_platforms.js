/**
 * 平台显示名 + 主题色。Web / MP 共用，避免手抄两份。
 * 与 server/config 中的平台定义保持一致。
 * 颜色对齐小程序设计稿（2026-08-21 微信绿重构版）。
 */
const PLATFORM_INFO = {
  quark: { name: '夸克网盘', color: '#1A94FF' },
  aliyun: { name: '阿里云盘', color: '#FF6B38' },
  baidu: { name: '百度网盘', color: '#2A5BF2' },
  '115': { name: '115 网盘', color: '#ED3D3D' },
  xunlei: { name: '迅雷云盘', color: '#0D87E0' },
  tianyi: { name: '天翼云盘', color: '#4BA0EB' },
  '123': { name: '123 网盘', color: '#3B82F6' },
  uc: { name: 'UC 网盘', color: '#FA5151' },
  others: { name: '其他', color: '#999999' }
}

module.exports = { PLATFORM_INFO }
