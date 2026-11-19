package jp.personal.alexaalarmskips

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

object AlarmRefreshScheduler {
    private const val PERIODIC_WORK_NAME = "alexa_alarm_periodic_refresh"
    private const val IMMEDIATE_WORK_NAME = "alexa_alarm_immediate_refresh"
    private const val PRE_TRIGGER_WORK_NAME = "alexa_alarm_pre_trigger"
    internal const val UNIQUE_DEFERRED_FALLBACK_WORK_NAME = "alexa_alarm_deferred_fallback"
    internal const val DEFERRED_FALLBACK_DELAY_SECONDS = 5L

    private fun networkConstraints(): Constraints {
        return Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
    }

    fun ensurePeriodicWork(context: Context) {
        val request = PeriodicWorkRequestBuilder<AlarmRefreshWorker>(15, TimeUnit.MINUTES)
            .setConstraints(networkConstraints())
            .build()

        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
            PERIODIC_WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }

    fun buildImmediateRefreshRequest(forceTokenRefresh: Boolean = false): OneTimeWorkRequest {
        return OneTimeWorkRequestBuilder<AlarmRefreshWorker>()
            .setConstraints(networkConstraints())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setBackoffCriteria(
                BackoffPolicy.LINEAR,
                WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS
            )
            .setInputData(workDataOf(AlarmRefreshWorker.KEY_FORCE_REFRESH to forceTokenRefresh))
            .build()
    }

    fun enqueueImmediateRefresh(context: Context, forceTokenRefresh: Boolean = false) {
        val request = buildImmediateRefreshRequest(forceTokenRefresh)

        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            IMMEDIATE_WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            request
        )
    }

    fun schedulePreAlarmRefresh(context: Context, triggerAtMs: Long) {
        val delayMs = maxOf(10_000L, triggerAtMs - System.currentTimeMillis())
        val request = OneTimeWorkRequestBuilder<AlarmRefreshWorker>()
            .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
            .setConstraints(networkConstraints())
            .build()

        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            PRE_TRIGGER_WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            request
        )
    }

    internal fun buildDeferredFallbackWorkRequest(
        delaySeconds: Long = DEFERRED_FALLBACK_DELAY_SECONDS
    ): OneTimeWorkRequest {
        return OneTimeWorkRequestBuilder<AlarmRefreshWorker>()
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .setConstraints(networkConstraints())
            .setBackoffCriteria(
                BackoffPolicy.LINEAR,
                WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS
            )
            .build()
    }

    fun enqueueDeferredFallbackRefresh(
        context: Context,
        delaySeconds: Long = DEFERRED_FALLBACK_DELAY_SECONDS
    ) {
        val request = buildDeferredFallbackWorkRequest(delaySeconds)
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            UNIQUE_DEFERRED_FALLBACK_WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            request
        )
    }

    fun cancelDeferredFallbackRefresh(context: Context) {
        WorkManager.getInstance(context.applicationContext)
            .cancelUniqueWork(UNIQUE_DEFERRED_FALLBACK_WORK_NAME)
    }
}
