//! UTC 毫秒调度状态机；调用层负责时钟、凭据能力及共享锁。
use crate::webdav_settings::Schedule;
use serde::Serialize;
const DAY: u64 = 86_400_000;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub phase: &'static str,
    pub last_success_at: Option<u64>,
    pub next_due_at: Option<u64>,
    pub error: Option<String>,
}
pub struct Scheduler {
    status: BackupStatus,
    schedule: Schedule,
    failures: u32,
}
impl Scheduler {
    pub fn new(schedule: Schedule, last: Option<u64>, now: u64) -> Self {
        let next_due_at =
            interval(&schedule).map(|period| last.map_or(now, |last| last.saturating_add(period)));
        Self {
            status: BackupStatus {
                phase: "idle",
                last_success_at: last,
                next_due_at,
                error: None,
            },
            schedule,
            failures: 0,
        }
    }
    pub fn status(&self) -> BackupStatus {
        self.status.clone()
    }
    pub fn configure(&mut self, schedule: Schedule, now: u64) {
        if self.schedule != schedule {
            self.schedule = schedule;
            self.failures = 0;
            self.status.next_due_at = interval(&self.schedule).map(|period| {
                self.status
                    .last_success_at
                    .map_or(now, |last| last.saturating_add(period))
            });
            if self.status.phase != "running" {
                self.status.phase = "idle";
                self.status.error = None;
            }
        }
    }
    pub fn disable(&mut self, error: String) {
        if self.status.phase != "running" {
            self.status.phase = "disabled";
            self.status.next_due_at = None;
            self.status.error = Some(error);
        }
    }
    pub fn reconcile_success(&mut self, last: Option<u64>) {
        if self.status.phase != "running" && last > self.status.last_success_at {
            if let Some(last) = last {
                self.finish(last, Ok(()));
            }
        }
    }
    pub fn enable(&mut self, now: u64) {
        if self.status.phase == "disabled" {
            self.status.phase = "idle";
            self.status.error = None;
            self.status.next_due_at = interval(&self.schedule).map(|period| {
                self.status
                    .last_success_at
                    .map_or(now, |last| last.saturating_add(period))
            });
        }
    }
    pub fn begin(&mut self, now: u64, manual: bool) -> bool {
        if self.status.phase == "running"
            || (!manual && !self.status.next_due_at.is_some_and(|due| now >= due))
        {
            return false;
        }
        self.status.phase = "running";
        self.status.error = None;
        true
    }
    pub fn finish(&mut self, now: u64, result: Result<(), String>) {
        match result {
            Ok(()) => {
                self.failures = 0;
                self.status.last_success_at = Some(now);
                self.status.phase = "idle";
                self.status.error = None;
                self.status.next_due_at =
                    interval(&self.schedule).map(|period| now.saturating_add(period));
            }
            Err(error) => {
                self.failures = self.failures.saturating_add(1);
                self.status.phase = "error";
                self.status.error = Some(error);
                self.status.next_due_at = interval(&self.schedule).map(|_| {
                    now.saturating_add(
                        (60_000u64.saturating_mul(1u64 << self.failures.min(7).saturating_sub(1)))
                            .min(3_600_000),
                    )
                });
            }
        }
    }
    pub fn cleanup_warning(&mut self, message: Option<String>) {
        self.status.error = message;
    }
}
fn interval(schedule: &Schedule) -> Option<u64> {
    match schedule {
        Schedule::Off => None,
        Schedule::Daily => Some(DAY),
        Schedule::Weekly => Some(7 * DAY),
    }
}
pub fn utc_now() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间异常".to_string())
        .and_then(|time| u64::try_from(time.as_millis()).map_err(|_| "系统时间异常".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    const DAY: u64 = 86_400_000;
    #[test]
    fn persisted_success_after_interruption_replaces_stale_failure() {
        let mut s = Scheduler::new(Schedule::Daily, Some(100), 200);
        assert!(s.begin(200, true));
        s.finish(300, Err("中断".into()));
        s.reconcile_success(Some(250));
        assert_eq!(s.status().last_success_at, Some(250));
        assert_eq!(s.status().phase, "idle");
        assert_eq!(s.status().next_due_at, Some(250 + DAY));
    }
    #[test]
    fn off_never_runs_automatically_but_manual_runs() {
        let mut s = Scheduler::new(Schedule::Off, None, 100);
        assert!(!s.begin(100, false));
        assert!(s.begin(100, true));
    }
    #[test]
    fn restart_and_wake_catch_up_once_and_share_manual_lock() {
        let mut s = Scheduler::new(Schedule::Daily, Some(0), DAY * 5);
        assert!(s.begin(DAY * 5, false));
        assert!(!s.begin(DAY * 5, true));
        s.finish(DAY * 5, Ok(()));
        assert!(!s.begin(DAY * 5, false));
        assert_eq!(s.status().next_due_at, Some(DAY * 6));
    }
    #[test]
    fn failure_preserves_success_and_backoff_is_bounded() {
        let mut s = Scheduler::new(Schedule::Daily, Some(100), DAY + 100);
        for attempt in 0..10 {
            let now = s.status().next_due_at.unwrap_or(DAY + 100);
            assert!(s.begin(now, false));
            s.finish(now, Err("固定错误".into()));
            assert_eq!(s.status().last_success_at, Some(100));
            let delay = s.status().next_due_at.unwrap() - now;
            assert!(
                (60_000..=3_600_000).contains(&delay),
                "attempt {attempt}: {delay}"
            );
        }
    }
    #[test]
    fn weekly_waits_seven_days() {
        let mut s = Scheduler::new(Schedule::Weekly, Some(100), DAY + 100);
        assert_eq!(s.status().next_due_at, Some(DAY * 7 + 100));
        assert!(!s.begin(DAY + 100, false));
    }
}
