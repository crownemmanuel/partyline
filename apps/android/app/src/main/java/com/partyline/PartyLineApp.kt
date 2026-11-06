package com.partyline

import android.app.Application
import android.content.Context
import com.partyline.notify.Channels
import com.partyline.store.SecureStore

class PartyLineApp : Application() {
    val store: SecureStore by lazy { SecureStore(this) }

    override fun onCreate() {
        super.onCreate()
        Channels.create(this)
    }

    companion object {
        fun store(context: Context): SecureStore = (context.applicationContext as PartyLineApp).store
    }
}
