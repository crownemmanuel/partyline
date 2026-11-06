package com.partyline

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.mutableStateOf
import com.partyline.ui.PartyLineRoot
import com.partyline.ui.theme.PartyLineTheme

class MainActivity : ComponentActivity() {

    private val vm: SessionViewModel by viewModels()

    /** Set by notification taps; the UI opens the messages sheet and resets it. */
    val openMessages = mutableStateOf(false)

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        // Join still works without notifications/Bluetooth; mic is checked again on join.
        vm.onPermissionsReady()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)
        setContent {
            PartyLineTheme {
                PartyLineRoot(vm, openMessages, onRequestBatteryExemption = ::requestBatteryExemption, onOpenUrl = ::openUrl)
            }
        }
        val wanted = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
            if (Build.VERSION.SDK_INT >= 31) add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (savedInstanceState == null) permissions.launch(wanted.toTypedArray()) else vm.onPermissionsReady()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action == ACTION_OPEN_MESSAGES) openMessages.value = true
    }

    /** ANDROID.md 7: on the first live session ask once to ignore battery optimizations. */
    @SuppressLint("BatteryLife")
    fun requestBatteryExemption() {
        runCatching {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
            )
        }.onFailure {
            runCatching { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        }
    }

    private fun openUrl(url: String) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }

    companion object {
        const val ACTION_OPEN_MESSAGES = "com.partyline.OPEN_MESSAGES"
        const val EXTRA_MESSAGE_ID = "messageId"
    }
}
