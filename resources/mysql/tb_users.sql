/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8 */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

DROP TABLE IF EXISTS `tb_users`;
CREATE TABLE IF NOT EXISTS `tb_users` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(254) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint(1) unsigned NOT NULL DEFAULT '0',
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  `role` tinyint(1) unsigned NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_idx` (`user`),
  UNIQUE KEY `user_email_idx` (`email`),
  KEY `role_idx` (`role`),
  KEY `user_status_idx` (`status`),
  KEY `created_idx` (`created`),
  KEY `updated_idx` (`updated`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

INSERT IGNORE INTO `tb_users` (`id`, `user`, `email`, `password`, `name`, `role`, `status`, `created`, `updated`) VALUES
	(1, 'admin', 'admin@gplayer.local', '$2y$10$NINj/fIn5uU/k7nZqcpubux7hMyA9FXxV7sfFmplu1oEgduKHp0Ty', 'Admin', 0, 1, 0, 0),
	(2, 'demo', 'demo@gplayer.local', '$2y$10$CmeA6fPZckFBp2pnZlpPIOs8KSFxAC.BQtjImAPBTBu6m4D.qfWzm', 'Demo', 1, 1, 0, 0);

/*!40103 SET TIME_ZONE=IFNULL(@OLD_TIME_ZONE, 'system') */;
/*!40101 SET SQL_MODE=IFNULL(@OLD_SQL_MODE, '') */;
/*!40014 SET FOREIGN_KEY_CHECKS=IFNULL(@OLD_FOREIGN_KEY_CHECKS, 1) */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40111 SET SQL_NOTES=IFNULL(@OLD_SQL_NOTES, 1) */;
