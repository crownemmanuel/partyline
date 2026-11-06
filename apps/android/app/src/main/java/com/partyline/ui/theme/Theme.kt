package com.partyline.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Dark only: this is used backstage, in the dark, glanced at for a second. */
object PlColors {
    val Live = Color(0xFFE5484D)
    val Ok = Color(0xFF30A46C)
    val Warn = Color(0xFFF5A524)
    val Idle = Color(0xFF2B2F36)
    val Surface = Color(0xFF15171A)
    val Background = Color(0xFF0B0C0E)
    val Muted = Color(0xFF8B9098)
    /** Talk button idle (shared with iOS / web). */
    val Talk = Color(0xFF3A7BD5)
    val IsolationOn = Color(0xFF1E4D2B)
}

private val scheme = darkColorScheme(
    primary = Color(0xFF4C8DFF),
    onPrimary = Color.White,
    secondary = Color(0xFF9AA4B2),
    background = PlColors.Background,
    surface = PlColors.Surface,
    surfaceVariant = Color(0xFF1E2126),
    onBackground = Color(0xFFECEEF1),
    onSurface = Color(0xFFECEEF1),
    onSurfaceVariant = PlColors.Muted,
    error = PlColors.Live,
)

@Composable
fun PartyLineTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}
