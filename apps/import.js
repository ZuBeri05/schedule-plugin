import plugin from '../../../lib/plugins/plugin.js'
import ScheduleData from '../model/scheduleData.js'
import axios from 'axios'
import ical from 'node-ical'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * 课程表导入功能
 */
export class scheduleImport extends plugin {
  constructor() {
    super({
      name: '课程表导入',
      dsc: '导入各平台课程表',
      event: 'message',
      priority: 4999,
      rule: [
        {
          reg: '^#导入wakeup\\s+(.+)$',
          fnc: 'importWakeUpByCommand'
        },
        {
          reg: '^这是来自「WakeUp课程表」的课表分享.*?分享口令为「(.+?)」',
          fnc: 'importWakeUpAuto'
        },
        {
          reg: '^#导入ics\\s+(.+)$',
          fnc: 'importICS'
        }
      ]
    })
  }

  /**
   * 通过指令导入WakeUp课程表
   */
  async importWakeUpByCommand(e) {
    const code = e.msg.replace(/^#导入wakeup\s+/, '').trim()
    
    if (!code) {
      await e.reply('请提供WakeUp分享口令\n格式：#导入wakeup <口令>')
      return true
    }
    
    // 提取口令（如果包含在引号中）
    const match = code.match(/「(.+?)」/)
    const finalCode = match ? match[1] : code
    
    return await this.doImportWakeUp(e, finalCode)
  }

  /**
   * 自动识别WakeUp分享消息
   */
  async importWakeUpAuto(e) {
    const match = e.msg.match(/分享口令为「(.+?)」/)
    if (!match) {
      await e.reply('未找到分享口令')
      return true
    }
    
    return await this.doImportWakeUp(e, match[1])
  }

  /**
   * 导入WakeUp课程表（核心逻辑）
   */
  async doImportWakeUp(e, code) {
    await e.reply('正在读取WakeUp课程表...')
    
    try {
      // 尝试两个API地址
      let response
      try {
        response = await axios.get(`https://api.wakeup.fun/share_schedule/get?key=${code}`, {
          headers: { 'version': '280' },
          timeout: 10000
        })
      } catch {
        response = await axios.get(`https://i.wakeup.fun/share_schedule/get?key=${code}`, {
          headers: { 'version': '280' },
          timeout: 10000
        })
      }
      
      if (!response.data || !response.data.data) {
        await e.reply('数据读取失败，可能是分享口令无效或已过期')
        return true
      }
      
      // 解析数据
      const lines = response.data.data.split('\n')
      const data = lines.map(line => JSON.parse(line))
      
      // data[1]: 节次信息
      const nodesInfo = {}
      for (const node of data[1]) {
        nodesInfo[node.node] = node
      }
      
      // data[3]: 课程信息
      const courseInfo = {}
      for (const course of data[3]) {
        courseInfo[course.id] = course.courseName
      }
      
      // data[2]: 课表基本信息
      const name = data[2].tableName
      const semesterStart = Math.floor(new Date(data[2].startDate).getTime() / 1000)
      
      // data[4]: 课程安排
      const courses = []
      for (const course of data[4]) {
        // 计算周数
        const weeks = []
        for (let i = course.startWeek; i <= course.endWeek; i++) {
          // type: 0=每周, 1=单周, 2=双周
          if (course.type === 0 || course.type % 2 === i % 2) {
            weeks.push(i)
          }
        }
        
        // 获取时间
        let startTime, endTime
        if (course.ownTime) {
          startTime = course.startTime
          endTime = course.endTime
        } else {
          startTime = nodesInfo[course.startNode].startTime
          endTime = nodesInfo[course.startNode + course.step - 1].endTime
        }
        
        courses.push({
          name: courseInfo[course.id],
          weeks,
          day: String(course.day),
          startTime,
          endTime,
          location: course.room || ''
        })
      }
      
      // 保存数据
      const result = ScheduleData.setData(e.user_id, name, semesterStart, courses)
      
      if (result.success) {
        let msg = `✅ 成功读取课程表：${name}`
        if (result.removedNotes && result.removedNotes.length > 0) {
          msg += `\n\n以下课程在新课程表中已不再可用，备注已移除：\n${result.removedNotes.join(' / ')}`
        }
        await e.reply(msg)
      } else {
        await e.reply('保存失败')
      }
      
    } catch (err) {
      logger.error(`[课程表] WakeUp导入失败: ${err}`)
      await e.reply('导入失败，请稍后重试')
    }
    
    return true
  }

  /**
   * 导入ICS日历文件
   */
  async importICS(e) {
    const link = e.msg.replace(/^#导入ics\s+/, '').trim()
    
    if (!link.match(/^(?:https?|webcal):\/\/.+/)) {
      await e.reply('请输入完整的链接')
      return true
    }
    
    await e.reply('正在读取ICS日历文件...')
    
    try {
      // 下载ICS文件
      const url = link.replace('webcal://', 'https://')
      const response = await axios.get(url, {
        timeout: 15000,
        responseType: 'text'
      })
      
      // 解析ICS
      const events = ical.sync.parseICS(response.data)
      
      // 提取域名作为课表名称
      const domain = url.match(/https?:\/\/([^/]+)/)[1]
      
      // 处理事件
      const courseMap = new Map()
      let timezoneName = 'Asia/Shanghai'
      let minStart = Infinity
      
      for (const event of Object.values(events)) {
        if (event.type !== 'VEVENT') continue
        
        const name = event.summary || '未命名课程'
        const start = event.start
        const end = event.end
        
        if (!start || !end) continue
        
        // 记录最早开始时间
        const startTime = start.getTime()
        if (startTime < minStart) minStart = startTime
        
        // 处理重复规则
        const instances = []
        if (event.rrule) {
          // 使用rrule库处理重复
          const dates = event.rrule.between(
            new Date(start),
            new Date(start.getTime() + 365 * 24 * 60 * 60 * 1000), // 一年内
            true
          )
          
          for (const date of dates) {
            instances.push({
              start: date,
              end: new Date(date.getTime() + (end - start))
            })
          }
        } else {
          instances.push({ start, end })
        }
        
        // 添加到课程列表
        for (const instance of instances) {
          const key = `${name}_${instance.start.getTime()}`
          if (!courseMap.has(key)) {
            courseMap.set(key, {
              name,
              start: instance.start,
              end: instance.end,
              location: event.location || ''
            })
          }
        }
      }
      
      if (courseMap.size === 0) {
        await e.reply('未找到有效的课程数据')
        return true
      }
      
      // 计算学期开始时间（最早课程的周一）
      const semesterStartDate = new Date(minStart)
      const day = semesterStartDate.getDay() || 7
      semesterStartDate.setDate(semesterStartDate.getDate() - day + 1)
      semesterStartDate.setHours(0, 0, 0, 0)
      const semesterStart = Math.floor(semesterStartDate.getTime() / 1000)
      
      // 转换为课程格式
      const courses = []
      for (const course of courseMap.values()) {
        const startDate = course.start
        const weekday = startDate.getDay() || 7
        
        // 计算周数
        const weekStart = new Date(startDate)
        weekStart.setDate(weekStart.getDate() - (weekday - 1))
        weekStart.setHours(0, 0, 0, 0)
        const week = Math.floor((weekStart - semesterStartDate) / (7 * 24 * 60 * 60 * 1000)) + 1
        
        courses.push({
          name: course.name,
          weeks: [week],
          day: String(weekday),
          startTime: `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`,
          endTime: `${String(course.end.getHours()).padStart(2, '0')}:${String(course.end.getMinutes()).padStart(2, '0')}`,
          location: course.location
        })
      }
      
      // 合并相同课程的周数
      const mergedCourses = []
      const courseGroups = new Map()
      
      for (const course of courses) {
        const key = `${course.name}_${course.day}_${course.startTime}_${course.endTime}`
        if (!courseGroups.has(key)) {
          courseGroups.set(key, { ...course })
        } else {
          const existing = courseGroups.get(key)
          existing.weeks.push(...course.weeks)
        }
      }
      
      for (const course of courseGroups.values()) {
        course.weeks = [...new Set(course.weeks)].sort((a, b) => a - b)
        mergedCourses.push(course)
      }
      
      // 保存数据
      const result = ScheduleData.setData(
        e.user_id,
        `iCalendar:${domain}`,
        semesterStart,
        mergedCourses,
        timezoneName
      )
      
      if (result.success) {
        await e.reply(`✅ 成功读取课程表\n共导入 ${mergedCourses.length} 门课程`)
      } else {
        await e.reply('保存失败')
      }
      
    } catch (err) {
      logger.error(`[课程表] ICS导入失败: ${err}`)
      await e.reply('导入失败，请检查链接是否正确')
    }
    
    return true
  }
}
