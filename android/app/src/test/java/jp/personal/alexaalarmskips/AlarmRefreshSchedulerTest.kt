package jp.personal.alexaalarmskips

import androidx.work.BackoffPolicy
import androidx.work.NetworkType
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AlarmRefreshSchedulerTest {

    @Test
    fun buildImmediateRefreshRequest_setsExpeditedAndMinLinearBackoff() {
        val request = AlarmRefreshScheduler.buildImmediateRefreshRequest(forceTokenRefresh = true)
        val workSpec = request.workSpec

        assertTrue(workSpec.expedited)
        assertEquals(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST, workSpec.outOfQuotaPolicy)
        assertEquals(BackoffPolicy.LINEAR, workSpec.backoffPolicy)
        assertEquals(WorkRequest.MIN_BACKOFF_MILLIS, workSpec.backoffDelayDuration)
        assertEquals(NetworkType.CONNECTED, workSpec.constraints.requiredNetworkType)
        assertTrue(workSpec.input.getBoolean(AlarmRefreshWorker.KEY_FORCE_REFRESH, false))
    }

    @Test
    fun buildImmediateRefreshRequest_defaultsForceRefreshToFalse() {
        val request = AlarmRefreshScheduler.buildImmediateRefreshRequest()
        assertFalse(request.workSpec.input.getBoolean(AlarmRefreshWorker.KEY_FORCE_REFRESH, true))
    }

    @Test
    fun buildDeferredFallbackWorkRequest_setsDelayNonExpeditedAndConstraints() {
        val request = AlarmRefreshScheduler.buildDeferredFallbackWorkRequest(delaySeconds = 5L)
        val workSpec = request.workSpec

        assertFalse(workSpec.expedited)
        assertEquals(5_000L, workSpec.initialDelay)
        assertEquals(BackoffPolicy.LINEAR, workSpec.backoffPolicy)
        assertEquals(WorkRequest.MIN_BACKOFF_MILLIS, workSpec.backoffDelayDuration)
        assertEquals(NetworkType.CONNECTED, workSpec.constraints.requiredNetworkType)
    }

    @Test
    fun webMutationInFlight_respectsTtlAndClear() {
        AlarmWidgetPlugin.resetInFlightForTest()
        try {
            val opId = "skip_123_1"
            assertFalse(AlarmWidgetPlugin.isWebMutationInFlight(opId, nowMs = 1_000L))

            AlarmWidgetPlugin.markWebMutationInFlight(opId, nowMs = 1_000L)
            assertTrue(AlarmWidgetPlugin.isWebMutationInFlight(opId, nowMs = 5_000L))
            assertTrue(
                AlarmWidgetPlugin.isWebMutationInFlight(
                    opId,
                    nowMs = 1_000L + AlarmWidgetPlugin.IN_FLIGHT_TTL_MS - 1L
                )
            )
            // TTL 経過後は自動失効して false を返す
            assertFalse(
                AlarmWidgetPlugin.isWebMutationInFlight(
                    opId,
                    nowMs = 1_000L + AlarmWidgetPlugin.IN_FLIGHT_TTL_MS
                )
            )

            AlarmWidgetPlugin.markWebMutationInFlight(opId, nowMs = 20_000L)
            assertTrue(AlarmWidgetPlugin.isWebMutationInFlight(opId, nowMs = 20_500L))
            AlarmWidgetPlugin.clearWebMutationInFlight(opId)
            assertFalse(AlarmWidgetPlugin.isWebMutationInFlight(opId, nowMs = 20_500L))
        } finally {
            AlarmWidgetPlugin.resetInFlightForTest()
        }
    }
}
