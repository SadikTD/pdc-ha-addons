# gomobile bindings (called from native code)
-keep class go.** { *; }
-keep class app.sentinel.tunnel.** { *; }
# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class app.sentinel.** { *** Companion; }
-keepclasseswithmembers class app.sentinel.** { kotlinx.serialization.KSerializer serializer(...); }
-dontwarn org.slf4j.**
