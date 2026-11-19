package jp.personal.alexaalarmskips

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class AlarmRefreshReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        when (action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                Log.i(TAG, "Received $action; ensuring periodic refresh work")
                AlarmRefreshScheduler.ensurePeriodicWork(context)
            }
            ACTION_DEBUG_REFRESH -> {
                val forceRefresh = intent.getBooleanExtra(EXTRA_FORCE_REFRESH, false)
                Log.i(TAG, "Received ACTION_DEBUG_REFRESH (forceRefresh=$forceRefresh)")
                AlarmRefreshScheduler.ensurePeriodicWork(context)
                AlarmRefreshScheduler.enqueueImmediateRefresh(context, forceRefresh)
            }
        }
    }

    companion object {
        const val ACTION_DEBUG_REFRESH = "jp.personal.alexaalarmskips.ACTION_DEBUG_REFRESH"
        const val EXTRA_FORCE_REFRESH = "forceRefresh"
        private const val TAG = "AlarmRefreshReceiver"
    }
}
