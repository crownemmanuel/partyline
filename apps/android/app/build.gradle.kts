plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.partyline"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.partyline"
        minSdk = 26
        targetSdk = 36
        // Every build gets a higher code (minutes since 2026-01-01 UTC), so an APK from the host
        // always installs over an older one. Override with -Ppartyline.versionCode=N.
        versionCode = providers.gradleProperty("partyline.versionCode").orNull?.toInt()
            ?: ((System.currentTimeMillis() / 60_000L) - 29_453_760L).toInt()
        versionName = "0.2.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Release key lives outside the repo (~/.partyline/keystore); path and passwords come from
    // ~/.gradle/gradle.properties or the environment. Every update must use the same key.
    fun secret(name: String): String? = providers.gradleProperty(name).orNull ?: System.getenv(name)
    val releaseStore = secret("PARTYLINE_RELEASE_STORE_FILE")?.let { file(it) }?.takeIf { it.exists() }
    signingConfigs {
        if (releaseStore != null) create("release") {
            storeFile = releaseStore
            storePassword = secret("PARTYLINE_RELEASE_STORE_PASSWORD")
            keyAlias = secret("PARTYLINE_RELEASE_KEY_ALIAS") ?: "partyline"
            keyPassword = secret("PARTYLINE_RELEASE_KEY_PASSWORD") ?: secret("PARTYLINE_RELEASE_STORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
            // Phones only; x86_64 is for the emulator (debug keeps all ABIs). One universal APK.
            ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        resources.excludes += setOf("META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
        // Compress native libs in the APK: phones download it from the host over Wi-Fi, so a
        // smaller file beats loading the .so straight from the APK. (Android extracts them on install.)
        jniLibs.useLegacyPackaging = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-process:2.9.4")
    implementation("androidx.lifecycle:lifecycle-service:2.9.4")

    implementation("io.livekit:livekit-android:2.30.0")
    implementation("androidx.core:core-telecom:1.0.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.security:security-crypto:1.1.0")
    implementation("androidx.media:media:1.7.1")

    implementation("androidx.camera:camera-camera2:1.5.1")
    implementation("androidx.camera:camera-lifecycle:1.5.1")
    implementation("androidx.camera:camera-view:1.5.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
