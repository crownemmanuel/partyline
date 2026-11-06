# PartyLine release (R8). Libraries (LiveKit, WebRTC, OkHttp, kotlinx-serialization, ML Kit,
# CameraX, core-telecom) ship their own consumer rules; these cover our own reflective/JNI edges.

# JNI: libdfjni.so binds to these names.
-keep class com.partyline.audio.DeepFilter { native <methods>; }
-keep class com.partyline.audio.DeepFilter$Companion { *; }

# kotlinx-serialization: keep generated serializers for our protocol models.
-keepclassmembers @kotlinx.serialization.Serializable class com.partyline.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.partyline.**$$serializer { *; }

# Keep line numbers for readable crash logs.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
