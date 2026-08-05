/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8 */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

DROP TABLE IF EXISTS `tb_gdrive_auth`;
CREATE TABLE IF NOT EXISTS `tb_gdrive_auth` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `api_key` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `client_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `client_secret` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `refresh_token` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `status` tinyint(1) unsigned NOT NULL DEFAULT '0',
  `bypass` tinyint(1) unsigned NOT NULL DEFAULT '0',
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `gdauth_email_idx` (`email`),
  KEY `gdauth_status_idx` (`status`),
  KEY `bypass_idx` (`bypass`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_gdrive_duplicate`;
CREATE TABLE IF NOT EXISTS `tb_gdrive_duplicate` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `gdrive_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `gdrive_email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `fileSize` bigint(20) unsigned NOT NULL DEFAULT '0',
  `md5Checksum` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sha1Checksum` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sha256Checksum` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `gdup_gdrive_id_idx` (`gdrive_id`),
  KEY `gdrive_duplicate_idx` (`title`,`description`(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_gdrive_mirrors`;
CREATE TABLE IF NOT EXISTS `tb_gdrive_mirrors` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `gdrive_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mirror_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mirror_email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `gmir_gdrive_id_idx` (`gdrive_id`),
  KEY `mirror_id_idx` (`mirror_id`),
  KEY `FK_tb_gdrive_mirrors_mirror_email_tb_gdrive_auth_email` (`mirror_email`),
  CONSTRAINT `FK_tb_gdrive_mirrors_mirror_email_tb_gdrive_auth_email` FOREIGN KEY (`mirror_email`) REFERENCES `tb_gdrive_auth` (`email`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_gdrive_queue`;
CREATE TABLE IF NOT EXISTS `tb_gdrive_queue` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `gdrive_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `delayed` tinyint(1) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `gque_gdrive_id_idx` (`gdrive_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_loadbalancers`;
CREATE TABLE IF NOT EXISTS `tb_loadbalancers` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `link` varchar(263) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint(1) unsigned NOT NULL DEFAULT '0',
  `public` tinyint(1) unsigned NOT NULL DEFAULT '0',
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  `disallow_hosts` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `disallow_continent` text COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `link_idx` (`link`),
  KEY `lb_status_idx` (`status`),
  KEY `public_idx` (`public`),
  KEY `created_idx` (`created`),
  KEY `updated_idx` (`updated`),
  FULLTEXT KEY `disallow_hosts_idx` (`disallow_hosts`),
  FULLTEXT KEY `disallow_continent_idx` (`disallow_continent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_maxmind`;
CREATE TABLE IF NOT EXISTS `tb_maxmind` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  `prefix_len` tinyint(3) unsigned DEFAULT NULL,
  `asn` int(10) unsigned DEFAULT NULL,
  `continent` char(2) COLLATE utf8mb4_unicode_ci NOT NULL,
  `country` varchar(5) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `maxmind_ip_idx` (`ip`),
  KEY `continent_idx` (`continent`),
  KEY `maxmind_country_idx` (`country`),
  KEY `FK_tb_maxmind_asn_tb_maxmind_asn_id` (`asn`),
  CONSTRAINT `FK_tb_maxmind_asn_tb_maxmind_asn_id` FOREIGN KEY (`asn`) REFERENCES `tb_maxmind_asn` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_maxmind_asn`;
CREATE TABLE IF NOT EXISTS `tb_maxmind_asn` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_plugins`;
CREATE TABLE IF NOT EXISTS `tb_plugins` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `folder` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `config` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint(1) unsigned NOT NULL DEFAULT '0',
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `plugin_idx` (`name`,`folder`),
  KEY `plugin_status_idx` (`status`),
  KEY `created_idx` (`created`),
  KEY `updated_idx` (`updated`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `tb_sessions`;
CREATE TABLE IF NOT EXISTS `tb_sessions` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  `useragent` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `stat` int(10) unsigned NOT NULL DEFAULT '9',
  `expires` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `session_ip_idx` (`ip`),
  KEY `session_idx` (`token`,`expires`,`stat`,`useragent`),
  KEY `created_idx` (`created`),
  KEY `FK_tb_sessions_username_tb_users_user` (`username`),
  CONSTRAINT `FK_tb_sessions_username_tb_users_user` FOREIGN KEY (`username`) REFERENCES `tb_users` (`user`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_settings`;
CREATE TABLE IF NOT EXISTS `tb_settings` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `key` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `key_idx` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_stats`;
CREATE TABLE IF NOT EXISTS `tb_stats` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `vid` bigint(20) unsigned NOT NULL,
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ua` int(10) unsigned NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `asn` int(10) unsigned DEFAULT NULL,
  `country` char(5) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `stat_ip_idx` (`ip`),
  KEY `asn_idx` (`asn`),
  KEY `stat_country_idx` (`country`),
  KEY `created_idx` (`created`),
  KEY `FK_tb_stats_vid_tb_videos_id` (`vid`),
  KEY `FK_tb_stats_ua_tb_stats_ua_id` (`ua`),
  CONSTRAINT `FK_tb_stats_ua_tb_stats_ua_id` FOREIGN KEY (`ua`) REFERENCES `tb_stats_ua` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_tb_stats_vid_tb_videos_id` FOREIGN KEY (`vid`) REFERENCES `tb_videos` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_stats_ua`;
CREATE TABLE IF NOT EXISTS `tb_stats_ua` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `ua` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ua_idx` (`ua`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_subtitles`;
CREATE TABLE IF NOT EXISTS `tb_subtitles` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `language` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `link` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `vid` bigint(20) unsigned NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `uid` int(10) unsigned NOT NULL,
  `order` tinyint(3) unsigned NOT NULL DEFAULT '0',
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `order_idx` (`order`),
  KEY `FK_tb_subtitles_vid_tb_videos_id` (`vid`),
  KEY `FK_tb_subtitles_uid_tb_users_id` (`uid`),
  CONSTRAINT `FK_tb_subtitles_uid_tb_users_id` FOREIGN KEY (`uid`) REFERENCES `tb_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_tb_subtitles_vid_tb_videos_id` FOREIGN KEY (`vid`) REFERENCES `tb_videos` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_subtitle_manager`;
CREATE TABLE IF NOT EXISTS `tb_subtitle_manager` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_size` int(10) unsigned NOT NULL DEFAULT '0',
  `file_type` varchar(25) COLLATE utf8mb4_unicode_ci NOT NULL,
  `language` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `uid` int(10) unsigned NOT NULL,
  `host` varchar(263) COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `file_name_idx` (`file_name`),
  KEY `host_idx` (`host`(255)),
  KEY `language_idx` (`language`),
  KEY `created_idx` (`created`),
  KEY `updated_idx` (`updated`),
  KEY `FK_tb_subtitle_manager_uid_tb_users_id` (`uid`),
  CONSTRAINT `FK_tb_subtitle_manager_uid_tb_users_id` FOREIGN KEY (`uid`) REFERENCES `tb_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

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

DROP TABLE IF EXISTS `tb_videos`;
CREATE TABLE IF NOT EXISTS `tb_videos` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `host` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `host_id` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `uid` int(10) unsigned NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  `poster` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint(1) unsigned NOT NULL DEFAULT '1',
  `views` int(10) unsigned NOT NULL DEFAULT '0',
  `dmca` tinyint(1) unsigned NOT NULL DEFAULT '0',
  `slug` varchar(150) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `slug_idx` (`slug`),
  KEY `videos_idx` (`host`,`host_id`(255)),
  KEY `video_status_idx` (`status`),
  KEY `dmca_idx` (`dmca`),
  KEY `views_idx` (`views`),
  KEY `title_idx` (`title`),
  KEY `poster_idx` (`poster`(255)),
  KEY `created_idx` (`created`),
  KEY `updated_idx` (`updated`),
  KEY `FK_tb_videos_uid_tb_users_id` (`uid`),
  CONSTRAINT `FK_tb_videos_uid_tb_users_id` FOREIGN KEY (`uid`) REFERENCES `tb_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_videos_alternatives`;
CREATE TABLE IF NOT EXISTS `tb_videos_alternatives` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `vid` bigint(20) unsigned NOT NULL,
  `host` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `host_id` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `order` tinyint(3) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `videos_alternatives_idx` (`host`,`host_id`(255)),
  KEY `order_idx` (`order`),
  KEY `FK_tb_videos_alternatives_vid_tb_videos_id` (`vid`),
  CONSTRAINT `FK_tb_videos_alternatives_vid_tb_videos_id` FOREIGN KEY (`vid`) REFERENCES `tb_videos` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_videos_hash`;
CREATE TABLE IF NOT EXISTS `tb_videos_hash` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `host` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `host_id` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `gdrive_email` varchar(254) COLLATE utf8mb4_unicode_ci NOT NULL,
  `data` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `videos_hash_idx` (`host`,`host_id`(255)),
  KEY `gdrive_email_idx` (`gdrive_email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tb_videos_sources`;
CREATE TABLE IF NOT EXISTS `tb_videos_sources` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `host` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `host_id` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `data` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `dl` tinyint(1) unsigned NOT NULL DEFAULT '0',
  `sid` int(10) unsigned DEFAULT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `expired` int(10) unsigned NOT NULL DEFAULT '0',
  `ua` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `lang` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  `cip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `videos_sources_idx` (`host`,`host_id`(255),`expired`,`dl`,`ua`,`lang`),
  KEY `videos_sources_ip_idx` (`ip`),
  KEY `cip_idx` (`cip`),
  KEY `expired_idx` (`expired`),
  KEY `created_idx` (`created`),
  KEY `FK_tb_videos_sources_sid_tb_loadbalancers_id` (`sid`),
  FULLTEXT KEY `data_idx` (`data`),
  CONSTRAINT `FK_tb_videos_sources_sid_tb_loadbalancers_id` FOREIGN KEY (`sid`) REFERENCES `tb_loadbalancers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

DROP TABLE IF EXISTS `tmp_videos_sources`;
CREATE TABLE IF NOT EXISTS `tmp_videos_sources` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `host` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `host_id` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `dl` tinyint(1) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `tmp_videos_sources_idx` (`host`,`host_id`(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP VIEW IF EXISTS `vwloadbalancers`;
CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `vw_loadbalancers` AS select `l`.`id` AS `id`,`l`.`name` AS `name`,`l`.`link` AS `link`,`l`.`public` AS `public`,`l`.`status` AS `status`,`l`.`created` AS `created`,`l`.`updated` AS `updated`,`l`.`disallow_hosts` AS `disallow_hosts`,`l`.`disallow_continent` AS `disallow_continent`,cast((select `c`.`value` from `tb_settings` `c` where (`c`.`key` = concat('active_connections_',`l`.`id`)) limit 1) as unsigned) AS `connections`,(select count(0) from `tb_videos_sources` `v` where (`l`.`id` = `v`.`sid`)) AS `playbacks` from `tb_loadbalancers` `l`
;

DROP VIEW IF EXISTS `vwsubtitle_manager`;
CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `vw_subtitle_manager` AS select `s`.`id` AS `id`,`s`.`file_name` AS `file_name`,`s`.`language` AS `language`,`s`.`host` AS `host`,`s`.`created` AS `created`,`s`.`updated` AS `updated`,`u`.`id` AS `uid`,`u`.`name` AS `name` from (`tb_subtitle_manager` `s` join `tb_users` `u` on((`s`.`uid` = `u`.`id`)))
;

DROP VIEW IF EXISTS `vw_users`;
CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `vw_users` AS select `u`.`id` AS `id`,`u`.`name` AS `name`,`u`.`user` AS `user`,`u`.`email` AS `email`,`u`.`status` AS `status`,`u`.`created` AS `created`,`u`.`updated` AS `updated`,`u`.`role` AS `role`,coalesce(`v`.`cnt`,0) AS `videos` from (`tb_users` `u` left join (select `tb_videos`.`uid` AS `uid`,count(0) AS `cnt` from `tb_videos` group by `tb_videos`.`uid`) `v` on((`v`.`uid` = `u`.`id`)))
;

DROP VIEW IF EXISTS `vwvideos`;
CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `vw_videos` AS select `v`.`id` AS `id`,`v`.`title` AS `title`,`v`.`host` AS `host`,`v`.`host_id` AS `host_id`,`v`.`uid` AS `uid`,`v`.`created` AS `created`,`v`.`updated` AS `updated`,`v`.`poster` AS `poster`,`v`.`status` AS `status`,`v`.`views` AS `views`,`v`.`dmca` AS `dmca`,`v`.`slug` AS `slug`,`u`.`name` AS `name`,exists(select 1 from `tb_videos_alternatives` `alt` where (`alt`.`vid` = `v`.`id`)) AS `has_alt`,exists(select 1 from `tb_subtitles` `sub` where (`sub`.`vid` = `v`.`id`)) AS `has_sub` from (`tb_videos` `v` join `tb_users` `u` on((`u`.`id` = `v`.`uid`)))
;

INSERT IGNORE INTO `tb_users` (`id`, `user`, `email`, `password`, `name`, `role`, `status`, `created`, `updated`) VALUES
	(1, 'admin', 'admin@gplayer.local', '$2y$10$NINj/fIn5uU/k7nZqcpubux7hMyA9FXxV7sfFmplu1oEgduKHp0Ty', 'Admin', 0, 1, 0, 0),
	(2, 'demo', 'demo@gplayer.local', '$2y$10$CmeA6fPZckFBp2pnZlpPIOs8KSFxAC.BQtjImAPBTBu6m4D.qfWzm', 'Demo', 1, 1, 0, 0);

INSERT IGNORE INTO `tb_settings` (`id`, `key`, `value`) VALUES (1, 'updated', '101');

/*!40103 SET TIME_ZONE=IFNULL(@OLD_TIME_ZONE, 'system') */;
/*!40101 SET SQL_MODE=IFNULL(@OLD_SQL_MODE, '') */;
/*!40014 SET FOREIGN_KEY_CHECKS=IFNULL(@OLD_FOREIGN_KEY_CHECKS, 1) */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40111 SET SQL_NOTES=IFNULL(@OLD_SQL_NOTES, 1) */;
