package app.sentinel.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Sentinel's palette (same as the web UI).
object C {
    val Ink950 = Color(0xFF05070B)
    val Ink900 = Color(0xFF0A0D14)
    val Ink850 = Color(0xFF0E121B)
    val Ink800 = Color(0xFF131824)
    val Ink700 = Color(0xFF1C2230)
    val Ink600 = Color(0xFF2A3142)
    val Violet = Color(0xFF8B5CF6)
    val VioletLight = Color(0xFFA78BFA)
    val Cyan = Color(0xFF22D3EE)
    val Rose = Color(0xFFF43F5E)
    val RoseLight = Color(0xFFFDA4AF)
    val Amber = Color(0xFFFBBF24)
    val Emerald = Color(0xFF34D399)
    val Sky = Color(0xFF38BDF8)
    val Text = Color(0xFFE2E8F0)
    val TextDim = Color(0xFF94A3B8)
    val TextFaint = Color(0xFF64748B)
    val Glass = Color(0x0CFFFFFF)
    val GlassBorder = Color(0x14FFFFFF)

    val accent = Brush.linearGradient(listOf(Violet, Cyan))
    val accentH = Brush.horizontalGradient(listOf(Violet, Cyan))
    val textAccent = Brush.horizontalGradient(listOf(VioletLight, Cyan))
}

private val scheme = darkColorScheme(
    primary = C.Violet,
    onPrimary = Color.White,
    secondary = C.Cyan,
    onSecondary = C.Ink950,
    tertiary = C.Amber,
    background = C.Ink950,
    onBackground = C.Text,
    surface = C.Ink900,
    onSurface = C.Text,
    surfaceVariant = C.Ink800,
    onSurfaceVariant = C.TextDim,
    surfaceContainer = C.Ink850,
    surfaceContainerHigh = C.Ink800,
    surfaceContainerHighest = C.Ink700,
    surfaceContainerLow = C.Ink900,
    outline = C.Ink600,
    outlineVariant = C.GlassBorder,
    error = C.Rose,
    onError = Color.White,
)

private val base = Typography()
private fun TextStyle.tight() = copy(fontFamily = FontFamily.Default, letterSpacing = (-0.2).sp)

private val typography = Typography(
    displaySmall = base.displaySmall.tight().copy(fontWeight = FontWeight.SemiBold),
    headlineLarge = base.headlineLarge.tight().copy(fontWeight = FontWeight.SemiBold),
    headlineMedium = base.headlineMedium.tight().copy(fontWeight = FontWeight.SemiBold, fontSize = 26.sp),
    headlineSmall = base.headlineSmall.tight().copy(fontWeight = FontWeight.SemiBold),
    titleLarge = base.titleLarge.tight().copy(fontWeight = FontWeight.SemiBold),
    titleMedium = base.titleMedium.tight().copy(fontWeight = FontWeight.SemiBold),
    titleSmall = base.titleSmall.tight().copy(fontWeight = FontWeight.Medium),
    bodyLarge = base.bodyLarge.tight(),
    bodyMedium = base.bodyMedium.tight(),
    bodySmall = base.bodySmall.tight(),
    labelLarge = base.labelLarge.tight().copy(fontWeight = FontWeight.SemiBold),
    labelMedium = base.labelMedium.tight().copy(fontWeight = FontWeight.Medium),
    labelSmall = base.labelSmall.tight().copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
)

@Composable
fun SentinelTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = typography) {
        CompositionLocalProvider(LocalContentColor provides C.Text, content = content)
    }
}
