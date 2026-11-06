package com.partyline.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.net.Inet4Address

/** A resolved `_partyline._tcp` service with its TXT record (§1). */
data class DiscoveredServer(
    val serverId: String,
    val name: String,
    val host: String,
    val port: Int,
    val fingerprint: String?,
    val serviceName: String,
)

/**
 * NsdManager browse + resolve for `_partyline._tcp`, holding a [WifiManager.MulticastLock]
 * while collecting (many phones drop multicast without it). Emits the full current list.
 */
class NsdDiscovery(private val context: Context) {

    fun servers(): Flow<List<DiscoveredServer>> = callbackFlow {
        val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val lock = wifi.createMulticastLock("partyline-mdns").apply { setReferenceCounted(false); acquire() }
        val found = linkedMapOf<String, DiscoveredServer>() // by serviceName
        val resolveQueue = ArrayDeque<NsdServiceInfo>()
        var resolving = false

        fun publish() = trySend(found.values.toList())

        lateinit var resolveNext: () -> Unit

        fun onResolved(info: NsdServiceInfo) {
            val attrs = info.attributes.mapValues { (_, v) -> v?.toString(Charsets.UTF_8) }
            val host = hostOf(info)
            val id = attrs["id"]
            if (host != null && id != null) {
                found[info.serviceName] = DiscoveredServer(
                    serverId = id,
                    name = attrs["name"]?.takeIf { it.isNotBlank() } ?: info.serviceName,
                    host = host,
                    port = info.port,
                    fingerprint = attrs["fp"]?.lowercase(),
                    serviceName = info.serviceName,
                )
                publish()
            }
        }

        resolveNext = resolve@{
            synchronized(resolveQueue) {
                if (resolving) return@resolve
                val next = resolveQueue.removeFirstOrNull() ?: return@resolve
                resolving = true
                @Suppress("DEPRECATION")
                nsd.resolveService(next, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                        Log.w(TAG, "resolve failed ${serviceInfo.serviceName}: $errorCode")
                        synchronized(resolveQueue) { resolving = false }
                        if (errorCode == NsdManager.FAILURE_ALREADY_ACTIVE) {
                            synchronized(resolveQueue) { resolveQueue.addLast(serviceInfo) }
                        }
                        resolveNext()
                    }

                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                        onResolved(serviceInfo)
                        synchronized(resolveQueue) { resolving = false }
                        resolveNext()
                    }
                })
            }
        }

        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "discovery failed: $errorCode")
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                synchronized(resolveQueue) { resolveQueue.addLast(serviceInfo) }
                resolveNext()
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                if (found.remove(serviceInfo.serviceName) != null) publish()
            }
        }

        publish()
        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        awaitClose {
            runCatching { nsd.stopServiceDiscovery(discoveryListener) }
            lock.release()
        }
    }

    private fun hostOf(info: NsdServiceInfo): String? {
        if (Build.VERSION.SDK_INT >= 34) {
            val addrs = info.hostAddresses
            return (addrs.firstOrNull { it is Inet4Address } ?: addrs.firstOrNull())?.hostAddress
        }
        @Suppress("DEPRECATION")
        return info.host?.hostAddress
    }

    companion object {
        private const val TAG = "NsdDiscovery"
        const val SERVICE_TYPE = "_partyline._tcp"
    }
}
