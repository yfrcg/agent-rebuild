# MEMORY.md

## 长期事实
- 记住：以后所有 API 接口必须返回统一的 { code, data, message } 格式，这是项目的核心约束
- 我是学生
- 我爱听古典音乐
- 我会下中国象棋
- 我喜欢踢足球
- 我喜欢打篮球
- 我会说日语
- 我叫周八
- 我喜欢吃苹果
- 我叫孙七
- 我叫赵六
- 我叫王五
- 我叫李四
- Recovered from pre-compaction flush: user: 记住：今天正在测试第一版记忆重建系统
user: 查记忆 测试
user: 读文件 memory/2026-04-18.md
user: flush
- 当前项目是在复现一个 OpenClaw 风格的完整架构。
- 第一阶段重点是先把记忆重建流程跑通。

## 稳定偏好
- 文件名保留英文，文件内容优先使用中文。
- 开发过程采用一步一步推进的方式。
- 优先做可运行的最小版本，再逐步增强。

## 长期目标
- 完成 memory、session、storage、gateway 四个核心部分。
- 先实现基于 workspace 文件的显式记忆系统。
- 后续再逐步补充 compaction、WebSocket 协议和前端入口。