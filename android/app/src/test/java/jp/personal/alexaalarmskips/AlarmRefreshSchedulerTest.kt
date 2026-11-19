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
}
