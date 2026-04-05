/**
 * 课程表工具函数
 */

/**
 * 计算当前是第几周
 * @param {number} semesterStart 学期开始时间戳（秒）
 * @param {number} current 当前时间戳（秒）
 * @param {string} timezone 时区
 * @returns {number} 周数（-1表示学期未开始）
 */
export function getWeek(semesterStart, current, timezone = 'Asia/Shanghai') {
  if (!semesterStart) semesterStart = 0
  if (current < semesterStart) return -1
  
  // 计算学期开始的周一
  const startDate = new Date(semesterStart * 1000)
  const startDay = startDate.getDay() || 7 // 周日为7
  startDate.setDate(startDate.getDate() - startDay + 1)
  startDate.setHours(0, 0, 0, 0)
  
  // 计算当前周的周一
  const currentDate = new Date(current * 1000)
  const currentDay = currentDate.getDay() || 7
  currentDate.setDate(currentDate.getDate() - currentDay + 1)
  currentDate.setHours(0, 0, 0, 0)
  
  // 计算周差
  const diffDays = Math.floor((currentDate - startDate) / (24 * 60 * 60 * 1000))
  return Math.floor(diffDays / 7) + 1
}

/**
 * 获取指定日期的课程
 * @param {object} data 课表数据
 * @param {number|string} date 日期（时间戳或日期字符串）
 * @returns {array|false} 课程列表，false表示学期已结束
 */
export function getCourses(data, date = null) {
  if (!data) return false
  
  // 处理日期参数
  let timestamp
  if (!date) {
    timestamp = Math.floor(Date.now() / 1000)
  } else if (typeof date === 'number') {
    timestamp = date
  } else {
    timestamp = Math.floor(new Date(date).getTime() / 1000)
  }
  
  const week = getWeek(data.semesterStart, timestamp, data.timezone)
  const weekday = new Date(timestamp * 1000).getDay() || 7 // 周日为7
  
  // 筛选当天的课程
  const courses = (data.courses || []).filter(course => {
    return course.weeks.includes(week) && parseInt(course.day) === weekday
  })
  
  if (courses.length > 0) {
    return courses
  }
  
  // 检查学期是否已结束
  const hasRemaining = (data.courses || []).some(course => {
    return Math.max(...course.weeks) >= week
  })
  
  return hasRemaining ? [] : false
}

/**
 * 获取时区GMT偏移
 * @param {string} timezone 时区
 * @returns {string} GMT偏移字符串
 */
export function getTimezoneGMTOffset(timezone) {
  const date = new Date()
  const options = { timeZone: timezone, timeZoneName: 'short' }
  const formatter = new Intl.DateTimeFormat('en-US', options)
  const parts = formatter.formatToParts(date)
  const timeZoneName = parts.find(part => part.type === 'timeZoneName')?.value || ''
  
  // 简单处理，返回GMT+8格式
  if (timezone === 'Asia/Shanghai') return 'GMT+8'
  
  // 计算偏移
  const offset = -date.getTimezoneOffset() / 60
  const sign = offset >= 0 ? '+' : '-'
  return `GMT${sign}${Math.abs(offset)}`
}

/**
 * 格式化时间为HH:mm
 * @param {string} time 时间字符串
 * @returns {string} 格式化后的时间
 */
export function formatTime(time) {
  if (!time) return ''
  const parts = time.split(':')
  return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`
}

/**
 * 计算剩余时间（分钟）
 * @param {string} targetTime 目标时间 HH:mm
 * @param {number} timestamp 当前时间戳（秒）
 * @returns {number} 剩余分钟数
 */
export function getRemainMinutes(targetTime, timestamp = null) {
  const now = timestamp ? new Date(timestamp * 1000) : new Date()
  const [hours, minutes] = targetTime.split(':').map(Number)
  
  const target = new Date(now)
  target.setHours(hours, minutes, 0, 0)
  
  return Math.ceil((target - now) / 60000)
}

/**
 * 检查时间是否在范围内
 * @param {string} currentTime 当前时间 HH:mm
 * @param {string} startTime 开始时间 HH:mm
 * @param {string} endTime 结束时间 HH:mm
 * @returns {boolean} 是否在范围内
 */
export function isTimeInRange(currentTime, startTime, endTime) {
  return currentTime >= startTime && currentTime < endTime
}
