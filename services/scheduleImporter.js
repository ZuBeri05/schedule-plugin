// services/scheduleImporter.js
import ScheduleData from '../model/scheduleData.js'
import { fetchStarlinkSchedule } from './starlinkApi.js'
import ICalExpander from 'ical-expander'

/**
 * 从星链分享码导入课表
 */
export async function importScheduleFromStarlinkCode(userId, code, event) {
  if (!code || !/^[0-9a-zA-Z\-_]+$/.test(code) || code.length < 4) {
    return { success: false, message: '星链分享码格式不正确，请检查后重试' }
  }
  
  try {
    const scheduleData = await fetchStarlinkSchedule(code)
    if (!scheduleData || !scheduleData.courses.length) {
      return { success: false, message: '获取星链课表失败，请检查分享码是否有效' }
    }

    // 转换日期格式为时间戳
    const semesterStart = Math.floor(new Date(scheduleData.semesterStart).getTime() / 1000)
    
    const saveResult = ScheduleData.setData(
      userId,
      scheduleData.tableName,
      semesterStart,
      scheduleData.courses
    )

    if (saveResult.success) {
      let msg = `✨ 星链课表导入成功！\n`
      msg += `📚 课表名称：${scheduleData.tableName}\n`
      msg += `📅 学期开始：${scheduleData.semesterStart}\n`
      msg += `📖 课程数量：${scheduleData.courses.length} 门`
      
      if (saveResult.removedNotes && saveResult.removedNotes.length > 0) {
        msg += `\n\n以下课程在新课程表中已不再可用，备注已移除：\n${saveResult.removedNotes.join(' / ')}`
      }
      
      return { success: true, message: msg }
    } else {
      return { success: false, message: '保存失败' }
    }
  } catch (err) {
    logger.error(`[星链导入] 失败: ${err}`)
    return { success: false, message: `导入失败：${err.message}` }
  }
}

/**
 * 从JSON数据导入课表（支持原生格式和拾光格式）
 */
export async function importScheduleFromJsonData(userId, jsonData, event) {
  try {
    let courses = []
    let semesterStart = null
    let tableName = "导入的课表"
    
    // 判断是否为拾光格式
    if (jsonData.timeSlots && Array.isArray(jsonData.timeSlots) && jsonData.courses) {
      // 拾光格式转换
      const timeSlotMap = new Map()
      for (const ts of jsonData.timeSlots) {
        timeSlotMap.set(ts.number, { start: ts.startTime, end: ts.endTime })
      }
      
      courses = jsonData.courses.map(course => {
        let startTime, endTime
        
        if (course.isCustomTime && course.customStartTime && course.customEndTime) {
          startTime = course.customStartTime
          endTime = course.customEndTime
        } else if (course.startSection && course.endSection) {
          const startSlot = timeSlotMap.get(course.startSection)
          const endSlot = timeSlotMap.get(course.endSection)
          
          if (!startSlot || !endSlot) {
            logger.warn(`[课表导入] 节次 ${course.startSection}-${course.endSection} 不在时间段定义中，跳过课程 ${course.name}`)
            return null
          }
          
          startTime = startSlot.start
          endTime = endSlot.end
        } else {
          logger.warn(`[课表导入] 课程 ${course.name} 缺少时间信息，跳过`)
          return null
        }
        
        return {
          name: course.name || "未知课程",
          teacher: course.teacher || "",
          location: course.position || "",
          day: String(course.day),
          startTime: startTime,
          endTime: endTime,
          weeks: course.weeks || []
        }
      }).filter(c => c !== null)
      
      // 学期开始日期
      if (jsonData.config && jsonData.config.semesterStartDate) {
        semesterStart = jsonData.config.semesterStartDate
      }
      tableName = "拾光课表导入"
    }
    else if (jsonData.courses && Array.isArray(jsonData.courses)) {
      // 原生格式
      courses = jsonData.courses.map(c => ({
        name: c.name,
        teacher: c.teacher || "",
        location: c.location || "",
        day: String(c.day),
        startTime: c.startTime,
        endTime: c.endTime,
        weeks: c.weeks || []
      }))
      
      semesterStart = jsonData.semesterStart || null
      tableName = jsonData.tableName || "导入的课表"
    }
    else {
      return { success: false, message: "无法识别的JSON格式，缺少必要的courses字段或timeSlots字段" }
    }
    
    // 校验数据完整性
    if (!courses.length) {
      return { success: false, message: "解析后没有有效的课程数据，请检查文件内容" }
    }
    
    if (!semesterStart) {
      const now = new Date()
      semesterStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      logger.warn(`[课表导入] 用户 ${userId} 的JSON未提供学期开始日期，使用默认值 ${semesterStart}`)
    }
    
    // 转换日期格式为时间戳
    const semesterStartTimestamp = Math.floor(new Date(semesterStart).getTime() / 1000)
    
    const saveResult = ScheduleData.setData(userId, tableName, semesterStartTimestamp, courses)
    
    if (saveResult.success) {
      let msg = `✅ 课表导入成功！\n`
      msg += `📚 课表名称：${tableName}\n`
      msg += `📅 学期开始：${semesterStart}\n`
      msg += `📖 课程数量：${courses.length} 门\n`
      msg += `使用 #今日课表 查看今日课程。`
      
      if (!jsonData.config?.semesterStartDate && !jsonData.semesterStart) {
        msg += `\n⚠️ 注意：未发现学期开始日期，已用今日日期代替，请检查导入数据是否有误`
      }
      
      return { success: true, message: msg }
    } else {
      return { success: false, message: '保存失败' }
    }
  } catch (err) {
    logger.error(`[课表导入] 处理JSON数据失败: ${err}`)
    return { success: false, message: "导入失败，请检查文件格式或联系管理员" }
  }
}

/**
 * 从 ICS 文本内容导入课表
 */
export async function importScheduleFromIcsData(userId, icsText, event) {
  try {
    const expander = new ICalExpander({ ics: icsText, maxIterations: 5000 })
    const all = expander.between(new Date(2000, 0, 1), new Date(2100, 0, 1))
    const occurrences = [...(all.events || []), ...(all.occurrences || [])]

    if (occurrences.length === 0) {
      return { success: false, message: '未在文件中找到任何课程事件' }
    }

    // 计算学期开始（最早事件所在周的周一）
    const dates = occurrences.map(o => {
      let sd = o.startDate
      if (typeof sd.toJSDate === 'function') sd = sd.toJSDate()
      return sd
    })
    
    const earliest = new Date(Math.min(...dates.map(d => d.getTime())))
    const semesterStartDate = getMondayOfSameWeek(earliest)
    const semesterStart = [
      semesterStartDate.getFullYear(),
      String(semesterStartDate.getMonth() + 1).padStart(2, '0'),
      String(semesterStartDate.getDate()).padStart(2, '0')
    ].join('-')

    const courseMap = new Map()
    
    for (const occ of occurrences) {
      let startDate = occ.startDate
      let endDate = occ.endDate
      if (typeof startDate.toJSDate === 'function') startDate = startDate.toJSDate()
      if (typeof endDate.toJSDate === 'function') endDate = endDate.toJSDate()

      const item = occ.item
      const summary = item.summary || '未知课程'

      let location = ''
      let teacher = ''
      const rawLocation = (item.location || '').trim()
      if (rawLocation) {
        const parts = rawLocation.split(/\s+/)
        if (parts.length >= 2) {
          teacher = parts.pop()
          location = parts.join(' ')
        } else {
          location = rawLocation
        }
      }

      const weekday = startDate.getDay() || 7
      const startTime = [startDate.getHours(), startDate.getMinutes()]
        .map(n => String(n).padStart(2, '0')).join(':')
      const endTime = [endDate.getHours(), endDate.getMinutes()]
        .map(n => String(n).padStart(2, '0')).join(':')
      
      const week = calculateWeekFromDate(semesterStart, startDate)
      if (week === null) continue

      const key = `${summary}|${weekday}|${startTime}|${endTime}`
      if (!courseMap.has(key)) {
        courseMap.set(key, {
          name: summary,
          day: String(weekday),
          startTime,
          endTime,
          weeks: new Set(),
          location,
          teacher
        })
      }
      
      const course = courseMap.get(key)
      course.weeks.add(week)
      if (!course.location && location) course.location = location
      if (!course.teacher && teacher) course.teacher = teacher
    }

    const courses = Array.from(courseMap.values()).map(c => ({
      ...c,
      weeks: Array.from(c.weeks).sort((a, b) => a - b)
    }))

    if (courses.length === 0) {
      return { success: false, message: '未能解析出有效的课程数据' }
    }

    const semesterStartTimestamp = Math.floor(new Date(semesterStart).getTime() / 1000)
    const saveResult = ScheduleData.setData(userId, 'ICS 课程表', semesterStartTimestamp, courses)

    if (saveResult.success) {
      let msg = `📅 ICS 课表导入成功！\n`
      msg += `📚 课表名称：ICS 课程表\n`
      msg += `📅 学期开始：${semesterStart}\n`
      msg += `📖 课程数量：${courses.length} 门`
      
      return { success: true, message: msg }
    } else {
      return { success: false, message: '保存失败' }
    }
  } catch (err) {
    logger.error(`[ICS导入] ${err}`)
    return { success: false, message: `导入 ICS 文件失败：${err.message}` }
  }
}

// 辅助函数
function getMondayOfSameWeek(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const offset = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - offset)
  return d
}

function calculateWeekFromDate(semesterStart, targetDate) {
  const start = new Date(semesterStart)
  if (isNaN(start)) return null

  const startMonday = getMondayOfSameWeek(start)
  const target = new Date(targetDate)
  target.setHours(0, 0, 0, 0)
  startMonday.setHours(0, 0, 0, 0)

  const diffDays = Math.floor((target - startMonday) / (1000 * 60 * 60 * 24))
  if (diffDays < 0) return null

  return Math.floor(diffDays / 7) + 1
}
